#!/usr/bin/env node
'use strict';

/*
 * Reading Room — app server.
 *
 * Serves the EXISTING static site (docs/) on loopback only and layers on the
 * app's affordances without touching the static build:
 *   • static-serves docs/ exactly as built (relative paths -> served unchanged);
 *   • for .html responses, injects (in memory, on the fly) a small app client —
 *     the on-disk docs/ stays byte-identical, so GitHub Pages is never affected;
 *   • a WebSocket bridge spawns your $SHELL via node-pty in the repo root for an
 *     integrated terminal (you run an AI — claude / codex / gemini — and
 *     `/explain-paper` yourself; this never bypasses the AI's permission prompts);
 *   • a chokidar watcher on reports/ (+ compares/ + dismissed.json) re-runs the
 *     EXISTING `python scripts/build.py` when a digest changes and pushes a refresh to
 *     the browser (it watches files — it does NOT parse terminal output);
 *   • small local API routes that call the existing build step, persist ghost
 *     dismissals to dismissed.json, read/write the reader's notes + full profile,
 *     run full backups through the EXISTING scripts/archive.py, and update the
 *     clone with plain git (never the GitHub API);
 *   • job bookkeeping for the one-click flows: a snapshot at job start, a poll
 *     that notices the assistant exiting, and a rollback (only ever of things
 *     that were NOT in the snapshot) when a job is stopped.
 *
 * SECURITY: binds to 127.0.0.1 only. Because it exposes a shell, it must never be
 * reachable from the network. No CORS is enabled; the WS shares the loopback
 * HTTP server. Every child process is spawned with an argument ARRAY (no shell
 * strings) and a hard timeout, so a hung tool can never hang a request.
 *
 * This file and everything under workmode/ are purely additive. Removing the
 * workmode/ directory leaves the Python build and the static site untouched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');

let express, WebSocketServer, chokidar, pty;
try {
  express = require('express');
  ({ WebSocketServer } = require('ws'));
  chokidar = require('chokidar');
} catch (e) {
  console.error('\n  ✗ The app\'s Node dependencies are not installed.');
  console.error('    Run:  cd workmode && npm install\n');
  process.exit(1);
}
try {
  pty = require('node-pty');
} catch (e) {
  pty = null; // terminal disabled but the UI + live rebuild still work
}

// ----------------------------------------------------------------------------
// Paths & config
// ----------------------------------------------------------------------------
const REPO = path.resolve(__dirname, '..');

// --- PATH augmentation -------------------------------------------------------
// A double-clicked .app inherits launchd's minimal PATH, so AI CLIs installed in
// the usual per-user locations (claude/codex live in ~/.local/bin, npm globals in
// /opt/homebrew/bin or ~/.npm-global/bin) are invisible to which() AND to the pty
// shell's environment — the app then greys out assistants that ARE installed.
// Append every standard install dir that exists; mutating process.env.PATH covers
// which(), the pty spawn, and the build child in one place.
(function augmentPath() {
  const home = os.homedir();
  const extras = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || '', 'npm'),
       path.join(home, 'AppData', 'Local', 'Programs', 'claude')]
    : ['/opt/homebrew/bin', '/usr/local/bin',
       path.join(home, '.local', 'bin'),        // claude/codex native installers
       path.join(home, '.npm-global', 'bin'),   // npm prefix installs
       path.join(home, 'bin')];
  const cur = (process.env.PATH || '').split(path.delimiter);
  const add = extras.filter((d) => d && !cur.includes(d) && fs.existsSync(d));
  if (add.length) process.env.PATH = cur.concat(add).join(path.delimiter);
})();
const DOCS = path.join(REPO, 'docs');
const REPORTS = path.join(REPO, 'reports');
const COMPARES = path.join(REPO, 'compares');
const CHATS = path.join(REPO, 'chats');
const PAPERS = path.join(REPO, 'papers');
const USER_DIR = path.join(REPO, 'user');
const BACKUPS = path.join(REPO, 'backups');   // archive.py's default zip location (gitignored)
const CLIENT = path.join(__dirname, 'client');
const NODE_MODULES = path.join(__dirname, 'node_modules');

// User config/state lives in user/ (gitignored, update-safe). Mirror scripts/build.py's
// user_path(): prefer user/<name>, fall back to the legacy repo-root path for reads;
// always write to user/ when that dir exists so app updates never clobber it.
function userPath(name) {
  const u = path.join(USER_DIR, name);
  if (fs.existsSync(u)) return u;
  const legacy = path.join(REPO, name);
  if (fs.existsSync(legacy)) return legacy;
  return u;
}
function userWritePath(name) {
  return fs.existsSync(USER_DIR) ? path.join(USER_DIR, name) : path.join(REPO, name);
}
const DISMISSED = userPath('dismissed.json');

// ---------------------------------------------------------------------------
// Reading state: status · priority · collections · ghost dismissals · theme
// ---------------------------------------------------------------------------
// The pages keep it in localStorage, which the browser scopes to the ORIGIN —
// port included. This server deliberately falls back to the next free port when
// 4317 is busy, and then the same library came up unread, untagged, and showed
// the tutorial again. Under the app the FILE is the source of truth: every page
// is seeded from it in <head> (stateSnippet) and writes through on every change.
// It is the same user/reading-state.json a backup zip carries, so a restore lands
// here too. On the static site nothing changes — localStorage stays on its own.
const STATE_MAX_VALUE = 4000;      // one collection list for one paper; far above real use
const STATE_MAX_KEYS = 20000;
function isStateKey(k) {
  return /^rr-(?:status|prio|tags)-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(k) || k === 'rr-dismissed' || k === 'rr-theme';
}
function readState() {
  const out = {};
  try {
    const j = JSON.parse(fs.readFileSync(userPath('reading-state.json'), 'utf8'));
    const s = j && j.state;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
    for (const k of Object.keys(s)) if (isStateKey(k)) out[k] = String(s[k]);
  } catch (e) {}
  return out;
}
function writeState(state) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  const doc = { tool: 'reading-room', kind: 'reading-state', exported: new Date().toISOString().slice(0, 10), state };
  const dest = userWritePath('reading-state.json');
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, dest);          // atomic: an interrupted write never truncates the stars
}


// A stable id for THIS INSTALLATION, so the client can scope per-copy browser state
// (the first-run tutorial flag) even under the app — where every copy is served
// from the same loopback origin at path "/". It must identify the INSTALL, not the
// folder: hashing the repo path meant "delete + re-clone into ~/ReadingRoom" kept
// the old id and the fresh copy never showed the tutorial. So: a random id,
// persisted in user/ (gitignored — a re-clone starts blank and mints a new one).
const REPO_KEY = (function () {
  const f = path.join(USER_DIR, '.install-id');
  try {
    const v = fs.readFileSync(f, 'utf8').trim();
    if (/^[a-f0-9]{8,}$/i.test(v)) return v.slice(0, 12);
  } catch (e) {}
  const v = crypto.randomBytes(6).toString('hex');
  try { fs.mkdirSync(USER_DIR, { recursive: true }); fs.writeFileSync(f, v + '\n'); } catch (e) {}
  return v;
})();
// NOTE: the intake path must be computed PER REQUEST (userWritePath resolves by
// whether user/ exists, and user/ can be created after the server starts — a fresh
// clone's launcher or /setup mkdirs it). A module-load constant here once made the
// POST write to the repo root while the watcher watched user/, so the "setup done"
// unlink was never seen and the app's busy box span forever.
const ROOT_INTAKE = path.join(REPO, '.setup-intake.json');

const HOST = '127.0.0.1';
const WANT_PORT = parseInt(process.env.RR_PORT || '4317', 10);
const NO_OPEN = process.argv.includes('--no-open') || process.env.RR_NO_OPEN === '1';
// Quit the server a short while after the last app window closes, so closing the
// app shuts everything down. Opt out with RR_KEEPALIVE=1 (e.g. headless serving).
const KEEPALIVE = process.env.RR_KEEPALIVE === '1';
// Set by ReadingRoom.app / run-server.cmd: a launcher loop relaunches us on exit 75.
// Under a bare `npm start` there is no loop, so the in-app "Restart now" is not offered.
const RESTARTABLE = process.env.RR_LAUNCHER === '1';
let restartPending = false;   // an update touched workmode/ and the server has not been restarted yet
const SHUTDOWN_GRACE_MS = parseInt(process.env.RR_SHUTDOWN_GRACE_MS || '5000', 10);

let ACTUAL_PORT = WANT_PORT; // updated once we actually bind
// When THIS server process started — /api/status reports it so a page can tell a
// freshly restarted server (after an update) from the one it was talking to.
const STARTED_AT = new Date().toISOString();

// Vendored browser assets (served from node_modules so the app works offline).
// Each entry lists candidate paths — the first that exists wins, which keeps us
// robust to minor packaging differences across xterm versions.
const VENDOR = {
  'xterm.js': [
    path.join(NODE_MODULES, '@xterm', 'xterm', 'lib', 'xterm.js'),
    path.join(NODE_MODULES, 'xterm', 'lib', 'xterm.js'),
  ],
  'xterm.css': [
    path.join(NODE_MODULES, '@xterm', 'xterm', 'css', 'xterm.css'),
    path.join(NODE_MODULES, 'xterm', 'css', 'xterm.css'),
  ],
  'addon-fit.js': [
    path.join(NODE_MODULES, '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
    path.join(NODE_MODULES, '@xterm', 'addon-fit', 'lib', 'xterm-addon-fit.js'),
    path.join(NODE_MODULES, 'xterm-addon-fit', 'lib', 'xterm-addon-fit.js'),
  ],
};

function vendorPath(name) {
  const candidates = VENDOR[name] || [];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(finder, [cmd], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout.trim().split(/\r?\n/)[0];
  } catch (e) {}
  return null;
}

function pythonCmd() {
  for (const c of ['python3', 'python', 'py']) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (r.status === 0 && /Python 3/.test((r.stdout || '') + (r.stderr || ''))) return c;
    } catch (e) {}
  }
  return null;
}

const PY_FOUND = pythonCmd();
const PY = PY_FOUND || 'python3';
const PYTHON_OK = !!PY_FOUND;   // surfaced in /api/status → the page tells the reader plainly

// Run a helper process (python / git / npm / pgrep) to completion with a HARD
// timeout. Every child the API routes start goes through here: args are always an
// array (no shell strings), output is capped, and on timeout the child is killed
// and the callback fires anyway — a hung tool can never hang a request.
//   cb({ code, stdout, stderr, timedOut, error })   code -1 = failed to run / timed out
function runProc(cmd, args, opts, cb) {
  const o = opts || {};
  const cap = o.cap || 64 * 1024;
  let child;
  try {
    child = spawn(cmd, args, { cwd: o.cwd || REPO, env: o.env || process.env, shell: !!o.shell, windowsHide: true });
  } catch (e) {
    return cb({ code: -1, stdout: '', stderr: '', timedOut: false, error: e.message });
  }
  let out = '', err = '', done = false, timedOut = false;
  child.stdout.on('data', (d) => { out = (out + d.toString()).slice(-cap); });
  child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-cap); });
  const finish = (code, spawnErr) => {
    if (done) return;
    done = true; clearTimeout(timer);
    cb({ code: spawnErr ? -1 : code, stdout: out, stderr: err, timedOut, error: spawnErr || null });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch (e) {}
    finish(-1, 'timed out after ' + Math.round((o.timeoutMs || 60000) / 1000) + ' s');
  }, o.timeoutMs || 60000);
  child.on('error', (e) => finish(-1, e.message));
  child.on('close', (code) => finish(code === null ? -1 : code)); // 'close' = stdio drained
}
function runP(cmd, args, opts) { return new Promise((resolve) => runProc(cmd, args, opts, resolve)); }
// Last N characters of a process's output, for error messages.
function tail(s, n) { s = String(s || '').trim(); n = n || 600; return s.length > n ? '…' + s.slice(-n) : s; }
// YYYYMMDD-HHMMSS in local time (matches scripts/archive.py's default file names).
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// ----------------------------------------------------------------------------
// Build runner (calls the EXISTING python scripts/build.py — never reimplements it)
// ----------------------------------------------------------------------------
let building = false;
let buildQueued = false;
let buildCbs = [];
// Last failure, replayed to every client that connects later — a build that fails
// at STARTUP would otherwise broadcast into an empty room and the window would
// open on a stale site with no visible error.
let lastBuildError = null;
const BUILD_TIMEOUT_MS = parseInt(process.env.RR_BUILD_TIMEOUT_MS || '300000', 10);   // 5 min

function runBuild(cb) {
  if (cb) buildCbs.push(cb);
  if (building) { buildQueued = true; return; } // a fresh build runs after this one
  building = true;
  broadcast({ type: 'building' });
  const child = spawn(PY, ['scripts/build.py'], { cwd: REPO });
  // a build that hangs (a cloud-evicted digest, a stuck python) would otherwise leave
  // `building` true forever and queue every later notes/restore/update/stop callback
  const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} err = (err + '\nscripts/build.py did not finish within ' + (BUILD_TIMEOUT_MS / 1000) + ' s and was stopped').slice(-8000); }, BUILD_TIMEOUT_MS);
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-8000); }); // cap as we append
  child.stdout.on('data', () => {}); // drain to avoid backpressure stalls
  const finish = (code, startupErr) => {
    clearTimeout(killer);
    building = false;
    if (code === 0) {
      console.log('  ✓ rebuilt docs/');
      lastBuildError = null;
      broadcast({ type: 'changed' });
    } else {
      const msg = (startupErr || err || ('exit ' + code)).slice(-400);
      console.error('  ✗ scripts/build.py:', msg);
      lastBuildError = msg;
      broadcast({ type: 'build-error', error: msg });
    }
    const cbs = buildCbs; buildCbs = [];                 // always fire — never hang a caller
    cbs.forEach((f) => { try { f(code); } catch (e) {} });
    if (buildQueued) { buildQueued = false; runBuild(); }
  };
  child.on('error', (e) => finish(1, e.message));
  child.on('exit', (code) => finish(code));
}

// ----------------------------------------------------------------------------
// HTML interception: inject the app client before </body> (in memory)
// ----------------------------------------------------------------------------
function workmodeSnippet() {
  return [
    '<!-- Reading Room app client (injected by the local server; NOT in docs/ on disk) -->',
    '<link rel="stylesheet" href="/__workmode/vendor/xterm.css">',
    '<link rel="stylesheet" href="/__workmode/workmode.css">',
    '<script>window.RR_WORKMODE = { ws: "/__workmode/ws", port: ' + ACTUAL_PORT + ', root: "' + REPO_KEY + '", dir: "' + crypto.createHash('sha1').update(REPO).digest('hex').slice(0, 8) + '" };</script>',
    '<script src="/__workmode/vendor/xterm.js"></script>',
    '<script src="/__workmode/vendor/addon-fit.js"></script>',
    '<script src="/__workmode/workmode.js"></script>',
  ].join('\n');
}

function stateSnippet() {
  // seeded in <head>, BEFORE the page's own scripts (and the theme flicker-guard)
  // read localStorage — after them would be one repaint too late
  const json = JSON.stringify(readState()).replace(/</g, '\\u003c');
  return '<script>window.RR_STATE=' + json
    + ';(function(s){try{for(var k in s)if(Object.prototype.hasOwnProperty.call(s,k))localStorage.setItem(k,s[k]);}catch(e){}})(window.RR_STATE);</script>';
}

function injectWorkmode(html) {
  // Idempotency must key off a marker UNIQUE to this injection — the Phase-2
  // graph add-on already contains `window.RR_WORKMODE` (feature-detection reads),
  // so checking for that substring would wrongly skip injecting on graph.html.
  if (html.indexOf('/__workmode/workmode.js') !== -1) return html;
  const snip = workmodeSnippet();
  // Inject before the LAST </body> — authored digest HTML (or a comment) can contain the
  // literal "</body>", and splicing at the first would land the scripts mid-content.
  const i = html.lastIndexOf('</body>');
  html = i !== -1 ? html.slice(0, i) + snip + '\n' + html.slice(i) : html + snip;
  // …and the reading state in <head>: the page's own scripts read localStorage as
  // they parse, so seeding them after the body would always be one paint too late.
  const state = stateSnippet();
  const h = html.indexOf('</head>');
  return h !== -1 ? html.slice(0, h) + state + '\n' + html.slice(h) : state + html;
}

// Map a request path to an HTML file inside docs/, or null if it isn't one.
function resolveHtml(reqPath) {
  let p;
  try { p = decodeURIComponent(reqPath); } catch (e) { return null; }
  if (p.endsWith('/')) p += 'index.html';
  if (!p.endsWith('.html')) return null;
  const abs = path.normalize(path.join(DOCS, p));
  if (abs !== DOCS && !abs.startsWith(DOCS + path.sep)) return null; // traversal guard
  return fs.existsSync(abs) ? abs : null;
}

// ----------------------------------------------------------------------------
// Express app
// ----------------------------------------------------------------------------
const app = express();
// 1 MB: the full-backup export carries the browser's reading state (one small record
// per paper) and the profile editor a Markdown document — both tiny, but a large
// library with many collections must never trip the limit.
app.use(express.json({ limit: '1mb' }));

// --- loopback origin guard (CSRF / drive-by defense) ---
// The server binds 127.0.0.1, but any web page the user visits can still fire
// cross-origin requests at it. GET/HEAD are read-only; every state-changing request
// must come from our own loopback page (matching Origin + port) and carry a loopback
// Host (which also defeats DNS-rebinding). The WS upgrade is guarded the same way via
// verifyClient below — without that, any site could open the terminal socket = RCE.
function isLoopbackHost(hostHeader) {
  const h = String(hostHeader || '').split(':')[0].replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}
function isLoopbackOrigin(origin) {
  if (!origin) return false;            // a same-origin browser fetch/WS always sends Origin
  try {
    const u = new URL(origin);
    const h = u.hostname.replace(/^\[|\]$/g, '');
    return (h === '127.0.0.1' || h === 'localhost' || h === '::1') && String(u.port) === String(ACTUAL_PORT);
  } catch (e) { return false; }
}
app.use((req, res, next) => {
  // the Host check applies to EVERY method: a DNS-rebinding page (Host: attacker.tld)
  // must not be able to read the profile / notes / repo path either
  if (!isLoopbackHost(req.headers.host)) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (isLoopbackOrigin(req.headers.origin)) return next();
  res.status(403).json({ ok: false, error: 'forbidden' });
});

// --- local API ---
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    port: ACTUAL_PORT,
    repo: REPO,
    terminal: !!pty,
    ais: { claude: !!which('claude'), codex: !!which('codex'), gemini: !!which('gemini') },
    python: PY,
    pythonOk: PYTHON_OK,
    startedAt: STARTED_AT,
    restartable: RESTARTABLE,
    restartPending,
    job: activeJob ? { kind: activeJob.kind, id: activeJob.id, startedAt: activeJob.startedAt, token: activeJob.token } : null,
  });
});

app.post('/api/build', (req, res) => {
  runBuild((code) => res.json({ ok: code === 0 }));
});

// Persist a ghost dismissal so the build (and rebuilds) never resurface it.
// The chokidar watcher on dismissed.json then triggers the rebuild + refresh.
app.post('/api/dismiss', (req, res) => {
  const id = req.body && req.body.id;
  if (typeof id !== 'string' || !id.trim()) {
    return res.status(400).json({ ok: false, error: 'id must be a non-empty string' });
  }
  const title = String((req.body && req.body.title) || '').slice(0, 300);

  let data = { dismissed: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(DISMISSED, 'utf8'));
    if (parsed && Array.isArray(parsed.dismissed)) data = parsed;
    else if (Array.isArray(parsed)) data = { dismissed: parsed };
  } catch (e) {}

  const already = data.dismissed.some((x) => (x && x.id ? x.id : x) === id);
  if (!already) {
    data.dismissed.push({ id, title, at: new Date().toISOString().slice(0, 10) });
    try {
      fs.writeFileSync(DISMISSED, JSON.stringify(data, null, 2) + '\n');
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
  res.json({ ok: true, already });
});

// Remove a discussion: delete chats/<id>/ and its generated page, then rebuild.
// id is shape-validated (no separators, no '..') so this can never escape chats/,
// and we only delete a directory that actually holds a chat.json.
app.post('/api/remove-chat', (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id.indexOf('..') !== -1) {
    return res.status(400).json({ ok: false, error: 'bad id' });
  }
  const dir = path.join(CHATS, id);
  if (!fs.existsSync(path.join(dir, 'chat.json'))) {
    return res.status(404).json({ ok: false, error: 'no such discussion' });
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(REPO, 'docs', 'chat', id), { recursive: true, force: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  runBuild((code) => res.json({ ok: code === 0 }));
});

// Read + write a paper's own notes (reports/<id>/notes.md) from the app.
// id is shape-validated (no separators, no '..') so this can never escape
// reports/, and it must name a folder that actually holds a digest.json.
function notesPathFor(rawId) {
  const id = String(rawId || '').trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id.indexOf('..') !== -1) return null;
  if (!fs.existsSync(path.join(REPORTS, id, 'digest.json'))) return null;
  return path.join(REPORTS, id, 'notes.md');
}
// List catalogued papers (id + title + venue/year) for the Compare / Deep dive /
// Discuss pickers — a lightweight read of reports/*/digest.json (docs/ doesn't
// expose the digests, so the client can't read them directly).
app.get('/api/reports', (req, res) => {
  const out = [];
  try {
    for (const id of fs.readdirSync(REPORTS)) {
      const dj = path.join(REPORTS, id, 'digest.json');
      if (!fs.existsSync(dj)) continue;
      try {
        const d = JSON.parse(fs.readFileSync(dj, 'utf8'));
        out.push({ id: d.id || id, title: d.title || id, year: d.year || null, venue: d.venue || (d.published && d.published.venue) || null });
      } catch (e) {}
    }
  } catch (e) {}
  out.sort((a, b) => (b.year || 0) - (a.year || 0));
  res.json({ ok: true, reports: out });
});

// Read one paper's digest (sections + deepdives) — the Deep dive form uses it to
// list a report's sections and to snapshot before/after so it knows when the run
// actually landed. id is shape-validated so it can't escape reports/.
app.get('/api/digest', (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id.indexOf('..') !== -1) return res.status(400).json({ ok: false, error: 'bad id' });
  const dj = path.join(REPORTS, id, 'digest.json');
  if (!fs.existsSync(dj)) return res.status(404).json({ ok: false, error: 'no such paper' });
  try { res.json({ ok: true, digest: JSON.parse(fs.readFileSync(dj, 'utf8')) }); }
  catch (e) { res.status(500).json({ ok: false, error: 'unreadable digest' }); }
});

app.get('/api/notes', (req, res) => {
  const p = notesPathFor(req.query.id);
  if (!p) return res.status(400).json({ ok: false, error: 'unknown paper id' });
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) {} // no notes yet -> empty editor
  res.json({ ok: true, text });
});
app.post('/api/notes', (req, res) => {
  const p = notesPathFor(req.body && req.body.id);
  if (!p) return res.status(400).json({ ok: false, error: 'unknown paper id' });
  const text = String((req.body && req.body.text) || '');
  try {
    if (text.trim() === '') { if (fs.existsSync(p)) fs.unlinkSync(p); } // empty save removes the block
    else fs.writeFileSync(p, text);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  runBuild((code) => res.json({ ok: code === 0 }));
});

// Persist the Setup questionnaire's answers so the /setup skill can read them and,
// with your approval, write user/profile.json + user/config.json. Written to
// user/.setup-intake.json (or repo-root .setup-intake.json on an un-migrated repo);
// the skill removes it when done.
app.post('/api/setup-intake', (req, res) => {
  const p = req.body;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return res.status(400).json({ ok: false, error: 'profile object required' });
  }
  try {
    fs.writeFileSync(userWritePath('.setup-intake.json'), JSON.stringify(p, null, 2) + '\n');
  } catch (e) {
    console.error('  ! setup-intake write failed:', e.message);
    return res.status(500).json({ ok: false, error: 'failed to save setup answers' });
  }
  res.json({ ok: true });
});

// Open an EXTERNAL url in the system browser, so links (e.g. arXiv) don't strand
// the chromeless app window, which has no Back button. Scheme-restricted; args are
// passed as an array (no shell), so there is no command injection.
app.post('/api/open', (req, res) => {
  const url = req.body && req.body.url;
  let u;
  try { u = new URL(String(url)); } catch (e) { return res.status(400).json({ ok: false, error: 'bad url' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return res.status(400).json({ ok: false, error: 'only http/https' });
  }
  if (!NO_OPEN) openUrl(u.href);
  res.json({ ok: true });
});

// --- full profile (user/profile.md) ---
// Free-form Markdown the commands read to calibrate reports (alongside profile.json).
// Read resolves like every other user file (user/ first, legacy root second); a write
// always lands in user/ (created if missing). No rebuild — nothing in docs/ shows it.
app.get('/api/profile-md', (req, res) => {
  let text = '', exists = false;
  try { text = fs.readFileSync(userPath('profile.md'), 'utf8'); exists = true; } catch (e) {}
  res.json({ ok: true, text, exists });
});
app.post('/api/profile-md', (req, res) => {
  const text = String((req.body && req.body.text) || '');
  try {
    if (text.trim() === '') {
      const p = userPath('profile.md');
      if (fs.existsSync(p)) fs.unlinkSync(p);         // an empty save removes the file
    } else {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(path.join(USER_DIR, 'profile.md'), text);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  res.json({ ok: true });
});

// --- full backup (zip) — a thin wrapper around the EXISTING scripts/archive.py ---
// The zip holds reports/, compares/, chats/, user/ (+ papers/*.pdf unless excluded).
// The browser's reading state (stars/status/collections live in localStorage) is
// written to user/reading-state.json just before zipping so it travels inside.
function listPdfs() {
  try { return fs.readdirSync(PAPERS).filter((n) => /\.pdf$/i.test(n)); } catch (e) { return []; }
}
function listDirsWith(base, file) {
  try { return fs.readdirSync(base).filter((n) => fs.existsSync(path.join(base, n, file))); } catch (e) { return []; }
}
function countDirsWith(base, file) { return listDirsWith(base, file).length; }
function backupCounts(includePdfs) {
  return {
    reports: countDirsWith(REPORTS, 'digest.json'),
    comparisons: countDirsWith(COMPARES, 'compare.json'),
    discussions: countDirsWith(CHATS, 'chat.json'),
    pdfs: includePdfs === false ? 0 : listPdfs().length,
  };
}
function downloadsDir() {
  const d = path.join(os.homedir(), 'Downloads');
  try { return fs.statSync(d).isDirectory() ? d : null; } catch (e) { return null; }
}
const exportedZips = new Set();   // only zips THIS process wrote may be revealed in Finder/Explorer
const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000;

app.get('/api/backup/info', (req, res) => {
  res.json({ ok: true, counts: backupCounts(true), downloadsDir: downloadsDir(), backupsDir: BACKUPS });
});

app.post('/api/backup/export', (req, res) => {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const includePdfs = b.pdfs !== false;
  const dest = typeof b.dest === 'string' ? b.dest : 'downloads';
  if (['downloads', 'backups', 'custom'].indexOf(dest) === -1) {
    return res.status(400).json({ ok: false, error: 'dest must be downloads, backups or custom' });
  }
  const fname = 'reading-room-backup-' + stamp() + '.zip';
  let out;
  if (dest === 'downloads') out = path.join(downloadsDir() || BACKUPS, fname);   // no Downloads folder -> backups/
  else if (dest === 'backups') out = path.join(BACKUPS, fname);
  else {
    const p = String(b.path || '').trim();
    if (!p || !path.isAbsolute(p)) return res.status(400).json({ ok: false, error: 'the custom destination must be an absolute path' });
    let target = path.normalize(p);
    try { if (fs.statSync(target).isDirectory()) target = path.join(target, fname); } catch (e) {}   // a folder -> default name inside it
    if (!/\.zip$/i.test(target)) return res.status(400).json({ ok: false, error: 'the destination must end in .zip' });
    let parentOk = false;
    try { parentOk = fs.statSync(path.dirname(target)).isDirectory(); } catch (e) {}
    if (!parentOk) return res.status(400).json({ ok: false, error: 'the destination folder does not exist' });
    if (fs.existsSync(target)) return res.status(400).json({ ok: false, error: 'a file already exists at that path — pick another name' });
    out = target;
  }
  if (b.state && typeof b.state === 'object' && !Array.isArray(b.state)) {
    // keep only the browser reading-state keys (mirrors account.html's isStateKey) —
    // never persist arbitrary key/value pairs a page might send
    const state = {};
    for (const k of Object.keys(b.state)) {
      if (/^rr-(status|prio|tags)-/.test(k) || k === 'rr-dismissed' || k === 'rr-theme') state[k] = String(b.state[k]);
    }
    const doc = { tool: 'reading-room', kind: 'reading-state', exported: new Date().toISOString().slice(0, 10), state };
    try {
      fs.mkdirSync(USER_DIR, { recursive: true });
      fs.writeFileSync(path.join(USER_DIR, 'reading-state.json'), JSON.stringify(doc, null, 2) + '\n');
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'could not save the reading state: ' + e.message });
    }
  }
  const args = ['scripts/archive.py', 'export', '-o', out];
  if (!includePdfs) args.push('--no-pdfs');
  runProc(PY, args, { timeoutMs: ARCHIVE_TIMEOUT_MS }, (r) => {
    if (r.code !== 0) {
      const msg = r.error || tail(r.stderr || r.stdout) || ('archive.py exited ' + r.code);
      console.error('  ✗ backup export failed:', msg);
      return res.status(500).json({ ok: false, error: msg });
    }
    let bytes = 0;
    try { bytes = fs.statSync(out).size; } catch (e) {}
    exportedZips.add(out);
    console.log('  ✓ backup written → ' + out);
    res.json({ ok: true, path: out, counts: backupCounts(includePdfs), includes_pdfs: includePdfs, bytes });
  });
});

// Reveal an exported zip in Finder / Explorer. Restricted to paths THIS process
// exported (never an arbitrary path from the page).
app.post('/api/backup/reveal', (req, res) => {
  const p = String((req.body && req.body.path) || '');
  if (!exportedZips.has(p)) return res.status(400).json({ ok: false, error: 'unknown backup path' });
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'that backup no longer exists' });
  try {
    if (process.platform === 'darwin') spawn('open', ['-R', p], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'win32') spawn('explorer', ['/select,' + p], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [path.dirname(p)], { stdio: 'ignore', detached: true }).unref();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
  res.json({ ok: true });
});

// Restore from a zip. The request body is the RAW zip bytes (fetch(..., {body: File})).
// It's saved to backups/import-<ts>.zip, then archive.py imports it (making its own
// pre-import safety snapshot first; --replace wipes the covered dirs for an exact
// restore). If the zip carried user/reading-state.json its "state" comes back so the
// page can restore the browser's stars/status/collections. Responds AFTER the rebuild.
const IMPORT_MAX_BYTES = 8 * 1024 * 1024 * 1024;   // a PDF-inclusive library can be large; streamed, never buffered
app.post('/api/backup/import', (req, res) => {
  const mode = String(req.query.mode || 'merge');
  if (mode !== 'merge' && mode !== 'replace') return res.status(400).json({ ok: false, error: 'mode must be merge or replace' });
  let zipPath;
  try {
    fs.mkdirSync(BACKUPS, { recursive: true });
    zipPath = path.join(BACKUPS, 'import-' + stamp() + '.zip');
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'could not prepare the backups folder: ' + e.message });
  }
  // stream the body straight into backups/import-<ts>.zip: express.raw would hold the
  // whole zip in memory (and writeFileSync caps out at 2 GiB anyway)
  const out = fs.createWriteStream(zipPath);
  let bytes = 0, first = true, bad = null, responded = false;
  const fail = (code, msg) => {
    if (responded) return; responded = true;
    try { out.destroy(); } catch (e) {}
    try { fs.rmSync(zipPath, { force: true }); } catch (e) {}
    res.status(code).json({ ok: false, error: msg });
  };
  req.on('data', (chunk) => {
    if (bad) return;
    if (first) {
      first = false;
      if (chunk.length < 4 || chunk[0] !== 0x50 || chunk[1] !== 0x4b) { bad = 'that is not a zip file'; fail(400, bad); req.destroy(); return; }
    }
    bytes += chunk.length;
    if (bytes > IMPORT_MAX_BYTES) { bad = 'the zip is larger than 8 GB'; fail(413, bad); req.destroy(); return; }
    if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
  });
  req.on('error', () => fail(400, 'upload interrupted'));
  req.on('aborted', () => fail(400, 'upload interrupted'));
  req.on('end', () => { if (!bad) out.end(); });
  out.on('error', (e) => fail(500, 'could not save the uploaded zip: ' + e.message));
  out.on('finish', () => {
    if (bad || responded) return;
    if (!bytes) return fail(400, 'send the zip file as the raw request body');
    responded = true;
    importZip(zipPath, mode, res);
  });
});
function importZip(zipPath, mode, res) {
  const args = ['scripts/archive.py', 'import', zipPath];
  const cleanup = () => { try { fs.rmSync(zipPath, { force: true }); } catch (e) {} };   // the upload copy is disposable (archive.py keeps its own pre-import snapshot)
  if (mode === 'replace') args.push('--replace');
  runProc(PY, args, { timeoutMs: ARCHIVE_TIMEOUT_MS }, (r) => {
    if (r.code !== 0) {
      const msg = r.error || tail(r.stderr || r.stdout) || ('archive.py exited ' + r.code);
      console.error('  ✗ backup import failed:', msg);
      cleanup();
      return res.status(500).json({ ok: false, error: msg });
    }
    const m = /restored (\d+) file/.exec(r.stdout || '');
    const written = m ? parseInt(m[1], 10) : 0;
    // manifest: archive.py list prints it as JSON (best effort — null if absent)
    runProc(PY, ['scripts/archive.py', 'list', zipPath], { timeoutMs: 60000 }, (l) => {
      let manifest = null;
      try { manifest = JSON.parse(l.stdout); } catch (e) {}
      // the browser state comes back ONLY when this zip carried user/reading-state.json —
      // a file left on disk by an earlier export must never overwrite the reader's current stars
      runProc(PY, ['-c', 'import sys,zipfile; print("yes" if "user/reading-state.json" in zipfile.ZipFile(sys.argv[1]).namelist() else "no")', zipPath],
        { timeoutMs: 60000 }, (z) => {
          let state = null;
          if (String(z.stdout).trim() === 'yes') {
            try {
              const rs = JSON.parse(fs.readFileSync(userPath('reading-state.json'), 'utf8'));
              if (rs && rs.state && typeof rs.state === 'object' && !Array.isArray(rs.state)) state = rs.state;
            } catch (e) {}
          }
          console.log('  ✓ restored ' + written + ' file(s) from ' + path.relative(REPO, zipPath) + (mode === 'replace' ? ' (replace)' : ' (merged)'));
          cleanup();
          runBuild((code) => res.json({ ok: true, written, manifest, state, mode, build: code === 0 }));
        });
    });
  });
}


// --- reading state ----------------------------------------------------------
// Every page is seeded from the file in <head>; these keep the file in sync with
// what the reader clicks. The key filter is the same one the backup uses, so a
// page can never park arbitrary data here.
app.get('/api/reading-state', (req, res) => res.json({ ok: true, state: readState() }));

app.post('/api/reading-state', (req, res) => {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const state = readState();
  const set = (b.set && typeof b.set === 'object' && !Array.isArray(b.set)) ? b.set : {};
  let touched = 0;
  for (const k of Object.keys(set)) {
    if (!isStateKey(k)) continue;
    const v = String(set[k]);
    if (v.length > STATE_MAX_VALUE) continue;
    if (state[k] !== v) { state[k] = v; touched++; }
  }
  for (const k of (Array.isArray(b.remove) ? b.remove : [])) {
    if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(state, k)) { delete state[k]; touched++; }
  }
  if (Object.keys(state).length > STATE_MAX_KEYS) return res.status(413).json({ ok: false, error: 'too many reading-state entries' });
  if (!touched) return res.json({ ok: true, unchanged: true });
  try { writeState(state); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  res.json({ ok: true, keys: Object.keys(state).length });
});

// --- add a paper from a PDF on this machine ---------------------------------
// Most fields are not on arXiv: the paper is a file in ~/Downloads, often behind a
// paywall no downloader can reach. The app window has no file browser of its own,
// so the Analyze overlay uploads the file here first and then analyzes the path.
// Streamed to papers/<slug>.pdf — never buffered (a scanned thesis is big).
const PDF_MAX_BYTES = 200 * 1024 * 1024;
function pdfSlug(name) {
  let s = String(name || '').replace(/\\/g, '/');
  s = s.slice(s.lastIndexOf('/') + 1).replace(/\.pdf$/i, '');
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'paper';
}
// never overwrite an existing PDF or shadow an existing report — paper, paper-2, …
function freePdfName(slug) {
  let id = slug;
  for (let n = 2; n <= 200; n++) {
    if (!fs.existsSync(path.join(PAPERS, id + '.pdf')) && !fs.existsSync(path.join(REPORTS, id))) break;
    id = slug + '-' + n;
  }
  return { id, file: path.join(PAPERS, id + '.pdf') };
}
app.post('/api/paper-upload', (req, res) => {
  const { id, file } = freePdfName(pdfSlug(req.query.name));
  try { fs.mkdirSync(PAPERS, { recursive: true }); }
  catch (e) { return res.status(500).json({ ok: false, error: 'could not prepare papers/: ' + e.message }); }
  const out = fs.createWriteStream(file);
  let bytes = 0, first = true, bad = null, responded = false;
  const fail = (code, msg) => {
    if (responded) return; responded = true;
    try { out.destroy(); } catch (e) {}
    try { fs.rmSync(file, { force: true }); } catch (e) {}
    res.status(code).json({ ok: false, error: msg });
  };
  req.on('data', (chunk) => {
    if (bad) return;
    if (first) {
      first = false;
      if (chunk.length < 5 || chunk.slice(0, 5).toString('latin1') !== '%PDF-') { bad = 'that file is not a PDF'; fail(400, bad); req.destroy(); return; }
    }
    bytes += chunk.length;
    if (bytes > PDF_MAX_BYTES) { bad = 'the PDF is larger than 200 MB'; fail(413, bad); req.destroy(); return; }
    if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
  });
  req.on('error', () => fail(400, 'upload interrupted'));
  req.on('aborted', () => fail(400, 'upload interrupted'));
  req.on('end', () => { if (!bad) out.end(); });
  out.on('error', (e) => fail(500, 'could not save the PDF: ' + e.message));
  out.on('finish', () => {
    if (bad || responded) return;
    if (!bytes) return fail(400, 'send the PDF as the raw request body');
    responded = true;
    console.log('  ✓ uploaded papers/' + id + '.pdf (' + Math.round(bytes / 1024) + ' KB)');
    res.json({ ok: true, id, path: 'papers/' + id + '.pdf', bytes });
  });
});

// --- remove a paper ---------------------------------------------------------
// Exactly the paths /remove deletes: the digest folder (source of truth), the
// downloaded PDF, any extracted text, and the generated page (the build only
// writes pages, it never deletes stale ones). Dependents are REPORTED, never
// deleted behind the reader's back — comparisons go only if they asked.
// Two-step by design: without confirm:true this answers with the plan.
function reportIdOk(id) { return !!id && /^[A-Za-z0-9._-]+$/.test(id) && id.indexOf('..') === -1; }
function idsOf(arr) { return (Array.isArray(arr) ? arr : []).map((x) => (x && typeof x === 'object' ? x.id : x)).filter(Boolean); }
function paperDependents(id) {
  const compares = [], citedBy = [];
  for (const slug of listDirsWith(COMPARES, 'compare.json')) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(COMPARES, slug, 'compare.json'), 'utf8'));
      if (idsOf(j.papers).indexOf(id) !== -1) compares.push(slug);
    } catch (e) {}
  }
  for (const rid of listDirsWith(REPORTS, 'digest.json')) {
    if (rid === id) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(REPORTS, rid, 'digest.json'), 'utf8'));
      if (idsOf(j.cites).indexOf(id) !== -1) citedBy.push(rid);
    } catch (e) {}
  }
  return { compares, citedBy };
}
app.post('/api/remove-paper', (req, res) => {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const id = String(b.id || '').trim();
  if (!reportIdOk(id)) return res.status(400).json({ ok: false, error: 'bad id' });
  if (!fs.existsSync(path.join(REPORTS, id, 'digest.json'))) return res.status(404).json({ ok: false, error: 'no such paper' });
  const dep = paperDependents(id);
  const paths = [];
  const push = (rel) => { if (fs.existsSync(path.join(REPO, rel))) paths.push(rel); };
  push('reports/' + id);
  push('papers/' + id + '.pdf');
  push('.cache/' + id + '.txt');
  push('docs/papers/' + id);
  const withCompares = b.compares === true;
  if (withCompares) dep.compares.forEach((s) => { push('compares/' + s); push('docs/compare/' + s); });
  let title = '';
  try { title = String(JSON.parse(fs.readFileSync(path.join(REPORTS, id, 'digest.json'), 'utf8')).title || ''); } catch (e) {}
  if (b.confirm !== true) return res.json({ ok: true, plan: true, id, title, paths, compares: dep.compares, citedBy: dep.citedBy });
  try { for (const rel of paths) fs.rmSync(path.join(REPO, rel), { recursive: true, force: true }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  console.log('  ✓ removed ' + id + ' (' + paths.length + ' path(s))');
  runBuild((code) => res.json({ ok: true, removed: paths, compares: withCompares ? dep.compares : [], citedBy: dep.citedBy, build: code === 0 }));
});

// --- diagnostics ------------------------------------------------------------
// "It doesn't work" is otherwise a hunt for workmode/workmode.log. One panel with
// the versions, what was found on PATH, how this copy was installed, and the tail
// of the log — copyable in one click.
function tailFile(p, maxBytes, maxLines) {
  try {
    const st = fs.statSync(p);
    const len = Math.min(st.size, maxBytes);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter((l) => l !== '').slice(-maxLines);
  } catch (e) { return []; }
}
app.get('/api/diagnostics', async (req, res) => {
  const win = process.platform === 'win32';
  const line = (r) => (r && r.code === 0 ? (String(r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] || '').slice(0, 120) : null);
  const ver = (cmd, args) => (which(cmd) ? runP(cmd, args, { timeoutMs: 8000, cap: 8192 }) : Promise.resolve(null));
  const isGit = fs.existsSync(path.join(REPO, '.git'));
  const [py, npm, claude, codex, gemini, head, branch, tag] = await Promise.all([
    PYTHON_OK ? runP(PY, ['--version'], { timeoutMs: 8000 }) : Promise.resolve(null),
    runP(win ? 'npm.cmd' : 'npm', ['--version'], { timeoutMs: 15000, shell: win }),
    ver('claude', ['--version']), ver('codex', ['--version']), ver('gemini', ['--version']),
    isGit ? gitP(['rev-parse', '--short', 'HEAD']) : Promise.resolve(null),
    isGit ? gitP(['rev-parse', '--abbrev-ref', 'HEAD']) : Promise.resolve(null),
    isGit ? gitP(['describe', '--tags', '--abbrev=0']) : Promise.resolve(null),
  ]);
  res.json({
    ok: true,
    app: {
      version: localVersion(), install: isGit ? 'git' : 'zip', commit: line(head), branch: line(branch), tag: line(tag),
      port: ACTUAL_PORT, repo: REPO, startedAt: STARTED_AT, restartable: RESTARTABLE, restartPending,
      terminal: !!pty, installId: REPO_KEY,
    },
    env: {
      platform: process.platform, arch: process.arch, node: process.version, npm: line(npm),
      python: PYTHON_OK ? line(py) : null, pythonCmd: PY, pythonOk: PYTHON_OK,
      ais: { claude: line(claude), codex: line(codex), gemini: line(gemini) },
      found: { claude: !!which('claude'), codex: !!which('codex'), gemini: !!which('gemini') },
    },
    library: Object.assign({}, backupCounts(true), { backups: (() => { try { return fs.readdirSync(BACKUPS).filter((f) => /\.zip$/i.test(f)).length; } catch (e) { return 0; } })() }),
    log: tailFile(path.join(__dirname, 'workmode.log'), 256 * 1024, 60),
  });
});

// --- library snapshots ------------------------------------------------------
// A small zip (no PDFs — they are re-downloadable) taken before every update and,
// if the reader turns it on, on a schedule. Only the newest few are kept so the
// backups folder can't grow without bound.
const SNAPSHOT_KEEP = 5;
const AUTO_BACKUP_CHECK_MS = 6 * 60 * 60 * 1000;
function pruneSnapshots(prefix) {
  try {
    fs.readdirSync(BACKUPS)
      .filter((f) => f.indexOf(prefix + '-') === 0 && /\.zip$/i.test(f))
      .map((f) => ({ f, t: (() => { try { return fs.statSync(path.join(BACKUPS, f)).mtimeMs; } catch (e) { return 0; } })() }))
      .sort((a, b) => b.t - a.t)
      .slice(SNAPSHOT_KEEP)
      .forEach((x) => { try { fs.rmSync(path.join(BACKUPS, x.f), { force: true }); } catch (e) {} });
  } catch (e) {}
}
function snapshot(prefix, cb) {
  try { fs.mkdirSync(BACKUPS, { recursive: true }); }
  catch (e) { return cb({ ok: false, error: e.message }); }
  const out = path.join(BACKUPS, prefix + '-' + stamp() + '.zip');
  runProc(PY, ['scripts/archive.py', 'export', '-o', out, '--no-pdfs'], { timeoutMs: ARCHIVE_TIMEOUT_MS }, (r) => {
    if (r.code !== 0) return cb({ ok: false, error: r.error || tail(r.stderr || r.stdout) || ('archive.py exited ' + r.code) });
    pruneSnapshots(prefix);
    cb({ ok: true, path: out });
  });
}
function snapshotP(prefix) { return new Promise((resolve) => snapshot(prefix, resolve)); }
function readPrefs() {
  try { const j = JSON.parse(fs.readFileSync(userPath('app-prefs.json'), 'utf8')); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; }
  catch (e) { return {}; }
}
function newestBackupAge() {
  try {
    const t = fs.readdirSync(BACKUPS).filter((f) => /\.zip$/i.test(f))
      .map((f) => { try { return fs.statSync(path.join(BACKUPS, f)).mtimeMs; } catch (e) { return 0; } })
      .sort((a, b) => b - a)[0];
    return t ? (Date.now() - t) : Infinity;
  } catch (e) { return Infinity; }
}
function maybeAutoBackup() {
  const days = parseInt(readPrefs().autoBackupDays, 10) || 0;
  if (!days || applyingUpdate || activeJob) return;      // never mid-update or mid-run
  if (newestBackupAge() < days * 86400000) return;
  snapshot('auto', (r) => {
    if (r.ok) console.log('  ✓ automatic backup → ' + path.relative(REPO, r.path));
    else console.log('  • automatic backup failed: ' + r.error);
  });
}
app.get('/api/backup/prefs', (req, res) => {
  const days = parseInt(readPrefs().autoBackupDays, 10) || 0;
  res.json({ ok: true, autoBackupDays: days, lastBackupAgeDays: newestBackupAge() === Infinity ? null : Math.floor(newestBackupAge() / 86400000) });
});
app.post('/api/backup/prefs', (req, res) => {
  const days = parseInt((req.body && req.body.autoBackupDays), 10);
  if (!(days === 0 || days === 1 || days === 7 || days === 30)) return res.status(400).json({ ok: false, error: 'autoBackupDays must be 0, 1, 7 or 30' });
  const prefs = readPrefs();
  prefs.autoBackupDays = days;
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(userWritePath('app-prefs.json'), JSON.stringify(prefs, null, 2) + '\n');
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  if (days) setTimeout(maybeAutoBackup, 500);
  res.json({ ok: true, autoBackupDays: days });
});

// --- updates (plain git on the clone — the repo may be private, so never the GitHub API) ---
// Non-interactive everywhere: no terminal prompts, ssh in batch mode, hard timeouts.
const GIT_ENV = Object.assign({}, process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes',
  // credential helpers (Git Credential Manager on Windows/macOS) prompt on their own —
  // a hidden fetch must fail quietly rather than pop a sign-in window out of nowhere
  GCM_INTERACTIVE: 'never',
  GIT_CONFIG_PARAMETERS: ((process.env.GIT_CONFIG_PARAMETERS || '') + " 'credential.interactive=false'").trim(),
});
function gitP(args, timeoutMs) { return runP('git', args, { env: GIT_ENV, timeoutMs: timeoutMs || 15000 }); }
function localVersion() {
  try { return fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim() || null; } catch (e) { return null; }
}
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
// Copies downloaded as a ZIP have no .git: they check the published VERSION on GitHub
// and update by downloading the branch archive and overlaying the app files in place
// (scripts/update_zip.py — the reader's data dirs are never written). RR_UPDATE_BASE
// is a test hook: a base URL serving VERSION, CHANGELOG.md and release.zip.
const UPDATE_REPO = process.env.RR_UPDATE_REPO || 'FrancescoPiatti/Reading-Room';
const UPDATE_BRANCH = process.env.RR_UPDATE_BRANCH || 'main';
const UPDATE_BASE = process.env.RR_UPDATE_BASE || null;
function updateUrls() {
  if (UPDATE_BASE) return { version: UPDATE_BASE + '/VERSION', changelog: UPDATE_BASE + '/CHANGELOG.md', zip: UPDATE_BASE + '/release.zip' };
  const raw = 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/' + UPDATE_BRANCH + '/';
  return { version: raw + 'VERSION', changelog: raw + 'CHANGELOG.md', zip: 'https://github.com/' + UPDATE_REPO + '/archive/refs/heads/' + UPDATE_BRANCH + '.zip' };
}
// A published RELEASE is the update channel, not the branch head: a tag is a
// deliberate "this one is ready", while `main` is whatever was pushed last —
// a ZIP copy updating from the branch could land mid-work code. Falls back to
// the branch when the repository has no releases yet (or the API can't be
// reached), which is exactly what copies installed before 1.3.0 used.
const UPDATE_API = process.env.RR_UPDATE_API || ('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest');
async function latestRelease() {
  if (UPDATE_BASE) return null;                       // test hook: a plain file server
  const r = await fetchText(UPDATE_API, 15000);
  if (!r.ok) return null;
  let j = null;
  try { j = JSON.parse(r.text); } catch (e) { return null; }
  if (!j || typeof j.tag_name !== 'string') return null;
  const tag = j.tag_name.trim();
  const version = tag.replace(/^v/i, '').trim();
  if (!/^\d+(\.\d+)*$/.test(version)) return null;    // not a version tag — ignore it
  // a packaged build for THIS platform (dependencies already installed) beats the
  // plain source archive; either way update_zip.py strips the one top-level folder
  const want = process.platform === 'darwin' ? /mac|darwin/i : process.platform === 'win32' ? /win/i : /linux/i;
  const assets = Array.isArray(j.assets) ? j.assets : [];
  const asset = assets.find((a) => a && typeof a.browser_download_url === 'string' && /\.zip$/i.test(a.name || '') && want.test(a.name || ''));
  return {
    tag, version,
    zip: (asset && asset.browser_download_url) || ('https://github.com/' + UPDATE_REPO + '/archive/refs/tags/' + encodeURIComponent(tag) + '.zip'),
    changelog: 'https://raw.githubusercontent.com/' + UPDATE_REPO + '/' + encodeURIComponent(tag) + '/CHANGELOG.md',
    packaged: !!asset,
  };
}

async function fetchText(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'ReadingRoom/' + (localVersion() || '1') + ' (update check)' }, redirect: 'follow' });
    const text = r.ok ? await r.text() : '';
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(t); }
}
// semver-ish compare: "1.2.0" vs "1.10.1" → numeric per segment; null/garbage sorts lowest
function cmpVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
// bullets of every CHANGELOG section newer than `local` → the modal's change list
function changelogSince(md, local) {
  const out = [];
  let take = false;
  for (const line of String(md || '').split(/\r?\n/)) {
    const h = /^##\s+(\d+(?:\.\d+)*)\b/.exec(line);
    if (h) { take = cmpVersions(h[1], local) > 0; continue; }
    if (!take) continue;
    const b = /^\s*[-*]\s+(.+)/.exec(line);
    if (b) out.push({ sha: '', subject: b[1].replace(/\*\*/g, '').replace(/`/g, '').slice(0, 200) });
    if (out.length >= 30) break;
  }
  return out;
}
// stream a URL to a file (release zip); rejects on HTTP errors, caps the size
async function downloadTo(url, dest, maxBytes) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'ReadingRoom/' + (localVersion() || '1') + ' (update)' } });
  if (!r.ok || !r.body) throw new Error('download failed (HTTP ' + r.status + ')');
  let bytes = 0;
  const out = fs.createWriteStream(dest);
  for await (const chunk of r.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) { out.destroy(); throw new Error('the update archive is unexpectedly large (> ' + Math.round(maxBytes / 1048576) + ' MB)'); }
    if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
  }
  await new Promise((res, rej) => { out.on('error', rej); out.end(res); });
  return bytes;
}
let updateCache = null;      // last check result (the /api/update payload)
let updateInFlight = null;   // Promise while a check runs — concurrent callers share it
let applyingUpdate = false;

async function doUpdateCheck() {
  const r = {
    ok: true, git: false, method: 'zip', checked: null, available: false, behind: 0, ahead: 0, branch: UPDATE_BRANCH,
    local: { commit: null, version: localVersion() }, remote: { commit: null, version: null },
    changes: [], upgradingChanged: false, error: null,
  };
  const done = (err) => { r.error = err || null; r.checked = new Date().toISOString(); return r; };
  const inside = await gitP(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true' || !fs.existsSync(path.join(REPO, '.git'))) {
    // a ZIP download: compare the published version, list the newer CHANGELOG sections
    const urls = updateUrls();
    const rel = await latestRelease();
    if (rel) {
      r.channel = 'release'; r.tag = rel.tag; r.packaged = rel.packaged; r.zipUrl = rel.zip;
      r.remote.version = rel.version;
      r.available = cmpVersions(rel.version, r.local.version) > 0;
      if (r.available) {
        const cl = await fetchText(rel.changelog, 15000);
        r.changes = cl.ok ? changelogSince(cl.text, r.local.version) : [];
        r.behind = r.changes.length;
      }
      return done(null);
    }
    r.channel = 'branch'; r.zipUrl = urls.zip;
    const v = await fetchText(urls.version, 15000);
    if (!v.ok) return done('Could not check for updates (' + (v.error || ('HTTP ' + v.status)) + ' fetching the published version — offline, or the repository is private).');
    r.remote.version = v.text.trim().split(/\s+/)[0] || null;
    if (!r.remote.version) return done('The update server has no VERSION file.');
    r.available = cmpVersions(r.remote.version, r.local.version) > 0;
    if (r.available) {
      const cl = await fetchText(urls.changelog, 15000);
      r.changes = cl.ok ? changelogSince(cl.text, r.local.version) : [];
      r.behind = r.changes.length;
    }
    return done(null);
  }
  r.git = true; r.method = 'git';
  r.local.commit = (await gitP(['rev-parse', '--short', 'HEAD'])).stdout.trim() || null;
  let branch = (await gitP(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (!branch || branch === 'HEAD' || branch.charAt(0) === '-') branch = 'main';   // detached -> main
  r.branch = branch;
  const origin = await gitP(['remote', 'get-url', 'origin']);
  if (origin.code !== 0) return done('This copy has no "origin" remote to update from.');
  const fetched = await gitP(['fetch', '--quiet', '--tags', 'origin'], 30000);
  if (fetched.code !== 0) return done('Could not reach the update server: ' + (fetched.error || tail(fetched.stderr, 300) || 'git fetch failed'));
  const ref = 'origin/' + branch;
  const rc = await gitP(['rev-parse', '--short', ref]);
  if (rc.code !== 0) return done('The update server has no "' + branch + '" branch.');
  r.remote.commit = rc.stdout.trim() || null;
  r.behind = parseInt((await gitP(['rev-list', '--count', 'HEAD..' + ref])).stdout.trim(), 10) || 0;
  r.ahead = parseInt((await gitP(['rev-list', '--count', ref + '..HEAD'])).stdout.trim(), 10) || 0;
  const log = await gitP(['log', '--format=%h%x09%s', '-n', '30', 'HEAD..' + ref]);
  r.changes = log.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf('\t');
    return i === -1 ? { sha: line, subject: '' } : { sha: line.slice(0, i), subject: line.slice(i + 1) };
  });
  const rv = await gitP(['show', ref + ':VERSION']);
  r.remote.version = rv.code === 0 ? (rv.stdout.trim() || null) : null;
  // the newest version TAG, when there is one, is the name to show for the update
  const tg = await gitP(['tag', '--list', '--sort=-v:refname', 'v*']);
  const newestTag = tg.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || null;
  if (newestTag) {
    r.tag = newestTag;
    const tv = newestTag.replace(/^v/i, '');
    if (cmpVersions(tv, r.remote.version) > 0) r.remote.version = tv;
  }
  const diff = await gitP(['diff', '--name-only', 'HEAD..' + ref]);
  r.upgradingChanged = diff.stdout.split(/\r?\n/).indexOf('UPGRADING.md') !== -1;
  r.available = r.behind > 0;
  return done(null);
}
function checkForUpdate() {
  if (updateInFlight) return updateInFlight;
  updateInFlight = doUpdateCheck()
    .catch((e) => ({ ok: true, git: false, checked: new Date().toISOString(), available: false, behind: 0, ahead: 0, branch: 'main',
                     local: { commit: null, version: localVersion() }, remote: { commit: null, version: null },
                     changes: [], upgradingChanged: false, error: e.message }))
    .then((r) => {
      updateCache = r; updateInFlight = null;
      if (r.available) console.log('  • update available: ' + (r.remote.version || r.remote.commit) + ' (' + r.behind + ' change(s) behind)');
      else if (r.error) console.log('  • update check: ' + r.error);
      return r;
    });
  return updateInFlight;
}
function scheduleUpdateChecks() {
  setTimeout(checkForUpdate, 5000).unref();
  setInterval(checkForUpdate, UPDATE_EVERY_MS).unref();
  setTimeout(maybeAutoBackup, 60000).unref();
  setInterval(maybeAutoBackup, AUTO_BACKUP_CHECK_MS).unref();
}

app.get('/api/update', (req, res) => {
  const refresh = String(req.query.refresh || '') === '1';
  const p = (refresh || !updateCache) ? checkForUpdate() : Promise.resolve(updateCache);
  p.then((r) => res.json(r)).catch((e) => res.status(500).json({ ok: false, error: e.message }));
});

// Apply: reset the generated docs/ (rebuildable), fast-forward pull, npm install if
// the app's dependencies changed, rebuild. Progress goes out as ws broadcasts so the
// page can show the steps; any failure reports the stage + a stderr tail and flags
// that the reader's assistant (/update) can take over.
app.post('/api/update/apply', async (req, res) => {
  if (applyingUpdate) return res.status(409).json({ ok: false, error: 'an update is already running' });
  applyingUpdate = true;
  const progress = (step, msg) => broadcast({ type: 'update-progress', step, msg });
  const fail = (stage, error, extra) => res.json(Object.assign({ ok: false, stage, error, needsAssistant: true }, extra || {}));
  // Belt before braces: update_zip.py stages its writes and git keeps its own history,
  // but a bad build or a half-merged digest is still the reader's work. A PDF-less zip
  // takes seconds and turns "my library looks wrong after updating" into a restore.
  let snap = { ok: false, error: null };
  try {
    progress('backup', 'Backing up your library first…');
    snap = await snapshotP('pre-update');
    if (!snap.ok) console.log('  • pre-update backup failed: ' + snap.error);
  } catch (e) { snap = { ok: false, error: e.message }; }
  const backupInfo = { backup: snap.ok ? path.basename(snap.path) : null, backupError: snap.ok ? null : snap.error };
  try {
    const inside = await gitP(['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true' || !fs.existsSync(path.join(REPO, '.git'))) {
      // ZIP copy: download the release archive, overlay the app files (data untouched)
      const info = updateCache && updateCache.method === 'zip' ? updateCache : await checkForUpdate();
      if (!info.available) return fail('pull', info.error || 'No newer version is published.', { needsAssistant: false });
      const from = localVersion();
      progress('pull', 'Downloading Reading Room ' + (info.remote.version || '') + '…');
      let zipPath;
      try {
        fs.mkdirSync(BACKUPS, { recursive: true });
        zipPath = path.join(BACKUPS, 'update-' + stamp() + '.zip');
        await downloadTo(info.zipUrl || updateUrls().zip, zipPath, 300 * 1024 * 1024);
      } catch (e) {
        try { if (zipPath) fs.rmSync(zipPath, { force: true }); } catch (e2) {}
        return fail('pull', 'Could not download the update: ' + e.message, { needsAssistant: false });
      }
      progress('pull', 'Installing the new files (your library is not touched)…');
      const up = await runP(PY, ['scripts/update_zip.py', zipPath], { cwd: REPO, timeoutMs: 5 * 60 * 1000, cap: 256 * 1024 });
      try { fs.rmSync(zipPath, { force: true }); } catch (e) {}
      let result = null;
      try { result = JSON.parse(String(up.stdout || '').trim().split(/\r?\n/).pop()); } catch (e) {}
      if (up.code !== 0 || !result || result.ok === false) {
        return fail('install', (result && result.error) || up.error || tail(up.stderr || up.stdout) || 'could not apply the archive', { needsAssistant: false });
      }
      const to = localVersion();
      console.log('  ✓ updated ' + from + ' → ' + to + ' (' + (result.changed.length + result.added.length) + ' file(s) changed)');
      if (result.installNeeded) {
        progress('install', 'Installing updated dependencies…');
        const win = process.platform === 'win32';
        const npm = await runP(win ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'],
          { cwd: path.join(REPO, 'workmode'), timeoutMs: 5 * 60 * 1000, shell: win, cap: 32 * 1024 });
        if (npm.code !== 0) return fail('install', npm.error || tail(npm.stderr || npm.stdout) || 'npm install failed', { from, to, needsAssistant: false });
      }
      progress('build', 'Rebuilding the site…');
      await new Promise((resolve) => runBuild(resolve));
      try { await checkForUpdate(); } catch (e) {}
      if (result.restartNeeded) restartPending = true;
      return res.json(Object.assign({ ok: true, method: 'zip', from, to, restartNeeded: !!result.restartNeeded, restartable: RESTARTABLE, upgradingChanged: !!result.upgradingChanged }, backupInfo));
    }
    let branch = (await gitP(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (!branch || branch === 'HEAD' || branch.charAt(0) === '-') branch = 'main';
    const from = (await gitP(['rev-parse', '--short', 'HEAD'])).stdout.trim();

    progress('pull', 'Checking the generated site…');
    const st = await gitP(['status', '--porcelain', '--untracked-files=no', '--', 'docs']);
    if (st.stdout.trim()) {
      progress('pull', 'Resetting generated site files (docs/ is rebuilt afterwards)…');
      const co = await gitP(['checkout', '--', 'docs'], 60000);
      if (co.code !== 0) return fail('pull', co.error || tail(co.stderr));
    }
    progress('pull', 'Downloading the update…');
    const pull = await gitP(['pull', '--ff-only', 'origin', branch], 120000);
    if (pull.code !== 0) return fail('pull', pull.error || tail(pull.stderr || pull.stdout) || 'git pull failed');
    const to = (await gitP(['rev-parse', '--short', 'HEAD'])).stdout.trim();
    const diff = await gitP(['diff', '--name-only', from + '..' + to]);
    const changed = diff.code === 0 ? diff.stdout.split(/\r?\n/).filter(Boolean) : [];
    console.log('  ✓ updated ' + from + ' → ' + to + ' (' + changed.length + ' file(s) changed)');

    if (changed.indexOf('workmode/package.json') !== -1 || changed.indexOf('workmode/package-lock.json') !== -1) {
      progress('install', 'Installing updated dependencies…');
      const win = process.platform === 'win32';
      // constant args only — the shell is needed on Windows to run npm.cmd
      const npm = await runP(win ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'],
        { cwd: path.join(REPO, 'workmode'), timeoutMs: 5 * 60 * 1000, shell: win, cap: 32 * 1024 });
      if (npm.code !== 0) return fail('install', npm.error || tail(npm.stderr || npm.stdout) || 'npm install failed', { from, to });
    }
    progress('build', 'Rebuilding the site…');
    await new Promise((resolve) => runBuild(resolve));
    // refresh the cached check BEFORE answering, so a page that reloads right after
    // the apply reads "up to date" instead of the stale "update available" payload
    try { await checkForUpdate(); } catch (e) {}
    const restartNeeded = changed.some((f) => f.indexOf('workmode/') === 0);
    if (restartNeeded) restartPending = true;     // survives "Later": /api/status carries it until the restart
    res.json(Object.assign({
      ok: true, method: 'git', from, to, restartNeeded, restartable: RESTARTABLE,
      upgradingChanged: changed.indexOf('UPGRADING.md') !== -1,
    }, backupInfo));
  } catch (e) {
    fail('pull', e.message);
  } finally {
    applyingUpdate = false;
  }
});

// Exit code 75 means "restart me": the launchers loop and relaunch the server on it.
app.post('/api/update/restart', (req, res) => {
  if (!RESTARTABLE) {
    return res.status(409).json({ ok: false, error: 'This server was not started by the Reading Room launcher, so it cannot restart itself — stop it (Ctrl-C) and start it again.' });
  }
  broadcast({ type: 'restarting' });
  res.json({ ok: true });
  console.log('\n  • restarting on request (exit 75)');
  setTimeout(() => { killTerm(); process.exit(75); }, 300);
});

// Stream an arXiv PDF through the local origin so it can be shown INSIDE the app
// (an iframe straight to arxiv.org would be blocked by X-Frame-Options and would
// strand the chromeless window). The host is hardcoded to arXiv and the id is
// shape-validated, so this is not an open proxy.
app.get('/pdf', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const okNew = /^\d{4}\.\d{4,5}(v\d+)?$/.test(id);
  const okOld = /^[a-z-]+(\.[a-z]{2})?\/\d{7}(v\d+)?$/i.test(id);
  const okSlug = /^[A-Za-z0-9._-]+$/.test(id) && id.indexOf('..') === -1;   // a local-PDF paper (e.g. hornik1989)
  if (!okNew && !okOld && !okSlug) return res.status(400).send('bad paper id');

  // a local copy first (downloaded by /explain-paper, or the reader's own PDF for a
  // paper that isn't on arXiv); only arXiv-shaped ids fall through to the proxy
  const local = path.join(PAPERS, path.basename(id.replace(/\//g, '-')) + '.pdf');
  if (fs.existsSync(local)) { res.type('application/pdf'); return res.sendFile(local); }
  if (!okNew && !okOld) return res.status(404).send('No PDF on disk for this paper (expected papers/' + path.basename(id) + '.pdf).');

  try {
    const up = await fetch('https://arxiv.org/pdf/' + id, { headers: { 'User-Agent': 'ReadingRoom/1.0 (local app)' } });
    if (!up.ok || !up.body) return res.status(502).send('arXiv returned ' + up.status);
    res.type('application/pdf');
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    res.status(502).send('could not fetch PDF: ' + e.message);
  }
});

// --- vendored browser assets (offline) ---
app.get('/__workmode/vendor/:file', (req, res) => {
  const f = vendorPath(req.params.file);
  if (!f) return res.status(404).send('vendor asset missing — run `npm install` in workmode/');
  res.set('Cache-Control', 'public, max-age=86400'); // immutable vendored asset
  res.sendFile(f);
});

// --- app client (css/js) ---
app.use('/__workmode', express.static(CLIENT));

// --- HTML pages: inject the app client on the fly ---
app.get('*', (req, res, next) => {
  const htmlPath = resolveHtml(req.path);
  if (!htmlPath) return next();
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); } catch (e) { return next(); }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(injectWorkmode(html));
});

// --- everything else: serve the built site untouched ---
app.use(express.static(DOCS));
app.use((req, res) => res.status(404).send('Not found'));

// ----------------------------------------------------------------------------
// HTTP server + WebSocket (terminal bridge + reload channel)
// ----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/__workmode/ws',
  // Reject any upgrade that isn't from our own loopback page. Without this, ANY
  // website the user visits while the app runs could open this socket, spawn the
  // shell, and run arbitrary commands (drive-by RCE). Mirrors the HTTP guard above.
  verifyClient: (info) => {
    const ok = isLoopbackOrigin(info.origin) && isLoopbackHost(info.req.headers.host);
    if (!ok) console.error('  ! refused ws upgrade — origin', info.origin || '(none)', 'host', info.req.headers.host || '(none)');
    return ok;
  },
});
// The ws library re-emits the http server's listen errors (e.g. EADDRINUSE) on the
// WebSocketServer instance too. Without a handler here that becomes an unhandled
// 'error' event that crashes the process BEFORE listenWithFallback can retry the
// next port (fatal in background mode, where there's no window to show it). Absorb
// EADDRINUSE — the http server's own 'error' handler drives the port fallback — and
// just log anything else.
wss.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') return; // handled by listenWithFallback
  console.error('  ! websocket server error:', (e && e.message) || e);
});
const clients = new Set(); // every connected ws (used for reload broadcasts)

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) { try { ws.send(s); } catch (e) {} }
  }
}

// ----------------------------------------------------------------------------
// Shared terminal session — persists across page navigations.
// One pty is shared by every page: navigating closes the old WebSocket and opens a
// new one, but the shell (and its scrollback) lives here and is replayed into the
// new page. That's what keeps a pre-typed command or a running agent from vanishing
// when you click through the app.
// ----------------------------------------------------------------------------
let sharedTerm = null;
let termBuffer = '';                  // recent pty output, replayed to a (re)attaching page
const TERM_BUFFER_CAP = 256 * 1024;   // cap the replay buffer (~256 KB of scrollback)
const termSubs = new Set();           // ws connections currently showing the terminal

function broadcastTerm(obj) {
  const s = JSON.stringify(obj);
  for (const ws of termSubs) { if (ws.readyState === 1) { try { ws.send(s); } catch (e) {} } }
}
function killTerm() { if (sharedTerm) { try { sharedTerm.kill(); } catch (e) {} sharedTerm = null; } }
// Epoch counter: a respawn kills the old shell and immediately starts a new one.
// The old shell's onData/onExit fire asynchronously AFTER the new spawn — without
// the epoch guard they'd broadcast a spurious 'exit' (which makes clients drop
// their queued input) or splice stale output into the new session's buffer.
let termEpoch = 0;
function spawnSharedTerm(cols, rows) {
  const myEpoch = ++termEpoch;
  const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash');
  sharedTerm = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd: REPO, env: process.env });
  sharedTerm.onData((d) => {
    if (myEpoch !== termEpoch) return;
    termBuffer += d;
    if (termBuffer.length > TERM_BUFFER_CAP) termBuffer = termBuffer.slice(-TERM_BUFFER_CAP);
    broadcastTerm({ type: 'data', data: d });
  });
  sharedTerm.onExit(() => {
    if (myEpoch !== termEpoch) return;
    broadcastTerm({ type: 'exit' }); sharedTerm = null; termBuffer = '';
  });
}

// ----------------------------------------------------------------------------
// Job bookkeeping for the one-click flows (Analyze / Compare / Deep dive / Discuss)
// ----------------------------------------------------------------------------
// The page tells us the moment it has submitted a flow command to the booted
// assistant (job-start). We take a SNAPSHOT of what the library holds right then
// and start polling whether the shared shell still has a child process: an
// assistant quit from the terminal (Ctrl-C, /exit) leaves the shell childless, and
// after three consecutive empty polls every page hears agent-exited — so an overlay
// never spins forever over a run that is already dead. On job-stop we kill the
// shell + the assistant inside it (a user stop) and ROLL BACK: whatever exists now
// but was NOT in the snapshot is removed and a deep dive's digest is restored
// byte-for-byte. Nothing that was in the snapshot is ever touched — "Stop" can only
// undo what this very run added.
const JOB_KINDS = ['analyze', 'compare', 'deepdive', 'discuss'];
const JOB_POLL_MS = 2000;
const JOB_EXIT_POLLS = 3;     // consecutive childless polls before agent-exited
let activeJob = null;         // { kind, id, snapshot, startedAt, exitAnnounced }
let jobPollTimer = null;
let jobPollBusy = false;
let jobIdlePolls = 0;

// Same shape rule as every id the API accepts: no separators, no '..'.
function safeSlug(raw) {
  const id = String(raw || '').trim();
  return (id && /^[A-Za-z0-9._-]+$/.test(id) && id.indexOf('..') === -1) ? id : null;
}
function listSubdirs(base) {
  try { return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch (e) { return []; }
}
function takeJobSnapshot(kind, id) {
  const snap = {
    // every folder is protected, digest or not (a stray notes.md is the reader's);
    // the *With sets say which of them already held their data file
    reportDirs: new Set(listSubdirs(REPORTS)),   reports: new Set(listDirsWith(REPORTS, 'digest.json')),
    compareDirs: new Set(listSubdirs(COMPARES)), compares: new Set(listDirsWith(COMPARES, 'compare.json')),
    chatDirs: new Set(listSubdirs(CHATS)),       chats: new Set(listDirsWith(CHATS, 'chat.json')),
    pdfs: new Set(listPdfs()),
    digest: null,                                // deepdive: the exact bytes to put back
  };
  // deep dive edits a digest in place; re-analysing a catalogued paper overwrites one —
  // keep the exact bytes so a Stop puts the report back as it was
  if ((kind === 'deepdive' || kind === 'analyze') && id) {
    try { snap.digest = fs.readFileSync(path.join(REPORTS, id, 'digest.json')); } catch (e) {}
  }
  return snap;
}

// Undo what a stopped run added under one data dir. A folder that did not exist at
// job start is removed whole (with its generated page); a folder that existed but
// had no <file> then and has one now loses just that new file. Returns the
// repo-relative paths removed. Never touches anything the snapshot already had.
function rollbackDir(base, file, dirsThen, withFileThen, docsBase, only) {
  const removed = [];
  for (const name of listSubdirs(base)) {
    if (only && name !== only) continue;          // the run's own target is known: touch nothing else
    const dir = path.join(base, name);
    try {
      if (!dirsThen.has(name)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(path.relative(REPO, dir));
      } else if (!withFileThen.has(name) && fs.existsSync(path.join(dir, file))) {
        fs.rmSync(path.join(dir, file), { force: true });
        removed.push(path.relative(REPO, path.join(dir, file)));
      } else continue;
      fs.rmSync(path.join(docsBase, name), { recursive: true, force: true });
    } catch (e) { console.error('  ! rollback: could not remove ' + path.relative(REPO, dir) + ' — ' + e.message); }
  }
  return removed;
}
// Scoped to what the run's KIND can have written (a Discuss never touches reports/,
// so a paper analysed meanwhile from a separate terminal is not collateral), and to
// the run's own target when its id is known.
function rollbackJob(job) {
  const s = job.snapshot, k = job.kind;
  let removed = [], restored = false;
  if (k === 'analyze') {
    removed = removed.concat(rollbackDir(REPORTS, 'digest.json', s.reportDirs, s.reports, path.join(DOCS, 'papers'), job.id || null));
    for (const n of listPdfs()) {
      if (s.pdfs.has(n)) continue;
      if (job.id && n !== job.id + '.pdf') continue;
      try { fs.rmSync(path.join(PAPERS, n), { force: true }); removed.push(path.relative(REPO, path.join(PAPERS, n))); }
      catch (e) { console.error('  ! rollback: could not remove papers/' + n + ' — ' + e.message); }
    }
  } else if (k === 'compare') {
    removed = removed.concat(rollbackDir(COMPARES, 'compare.json', s.compareDirs, s.compares, path.join(DOCS, 'compare')));
  } else if (k === 'discuss') {
    removed = removed.concat(rollbackDir(CHATS, 'chat.json', s.chatDirs, s.chats, path.join(DOCS, 'chat')));
  }
  if ((k === 'deepdive' || k === 'analyze') && s.digest && job.id) {
    const dj = path.join(REPORTS, job.id, 'digest.json');
    let now = null;
    try { now = fs.readFileSync(dj); } catch (e) {}
    if (!now || !now.equals(s.digest)) {
      try { fs.writeFileSync(dj, s.digest); restored = true; }
      catch (e) { console.error('  ! rollback: could not restore ' + path.relative(REPO, dj) + ' — ' + e.message); }
    }
  }
  return { removed, restored };
}

// How many direct children does the shared shell have? 0 = the assistant is gone;
// null = could not tell (tool missing / timed out) — never counted as a strike.
function countShellChildren(cb) {
  const pid = sharedTerm ? (sharedTerm.pid | 0) : 0;
  if (!pid) return cb(0);                        // no shell at all: nothing can be running
  if (process.platform === 'win32') {
    runProc('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter 'ParentProcessId=" + pid + "').Count"],
      { timeoutMs: 8000, cap: 4096 }, (r) => {
        const n = parseInt(String(r.stdout).trim(), 10);
        cb(r.code === 0 && !isNaN(n) ? n : null);
      });
  } else {
    // a login shell that exec's tmux/screen makes the pty process a multiplexer CLIENT
    // whose children live under the mux server — "no children" would be a false exit
    runProc('ps', ['-o', 'comm=', '-p', String(pid)], { timeoutMs: 5000, cap: 4096 }, (ps) => {
      if (/(^|\/)(tmux|screen|zellij)(\s|$)/.test(String(ps.stdout || ''))) return cb(null);
      runProc('pgrep', ['-P', String(pid)], { timeoutMs: 5000, cap: 4096 }, (r) => {
        if (r.code === 0) return cb(r.stdout.split(/\r?\n/).filter(Boolean).length || 1);
        if (r.code === 1) return cb(0);            // pgrep: exit 1 = nothing matched
        cb(null);
      });
    });
  }
}
function stopJobPoll() {
  if (jobPollTimer) { clearInterval(jobPollTimer); jobPollTimer = null; }
  jobIdlePolls = 0;
}
function startJobPoll() { stopJobPoll(); jobPollTimer = setInterval(pollJob, JOB_POLL_MS); }
function pollJob() {
  if (!activeJob || jobPollBusy) return;
  const job = activeJob;
  jobPollBusy = true;
  countShellChildren((n) => {
    jobPollBusy = false;
    if (activeJob !== job || !jobPollTimer) return;   // the job ended / was replaced meanwhile
    if (n === null) return;
    jobIdlePolls = n === 0 ? jobIdlePolls + 1 : 0;
    if (jobIdlePolls >= JOB_EXIT_POLLS) {
      stopJobPoll();                                   // keep activeJob: a job-stop can still roll back
      job.exitAnnounced = true;
      console.log('  • the assistant exited before the ' + job.kind + ' run finished');
      broadcast({ type: 'agent-exited', kind: job.kind, id: job.id });
    }
  });
}

// Kill the shared shell AND the assistant inside it (a user stop). The epoch bump
// turns the dying shell's async onExit into a no-op, so terminal pages get exactly
// one 'exit' — the one sent here, exactly like a normal shell exit. The children
// are ended explicitly on top of the tty hang-up, so a process that ignores SIGHUP
// still goes; cb fires once the signals are out.
function killTermForJob(cb) {
  const term = sharedTerm;
  if (!term) return cb();
  const pid = term.pid | 0;
  const myEpoch = ++termEpoch;
  sharedTerm = null; termBuffer = '';
  const finish = (kids) => {
    try { term.kill(); } catch (e) {}
    (kids || []).forEach((k) => { try { process.kill(k, 'SIGTERM'); } catch (e) {} });
    // a respawn may already have started a NEW shell while pgrep ran — then this
    // 'exit' would tear the fresh session down on the client; only announce our own
    if (termEpoch === myEpoch && !sharedTerm) broadcastTerm({ type: 'exit' });
    cb();
  };
  if (process.platform === 'win32') {
    runProc('taskkill', ['/T', '/F', '/PID', String(pid)], { timeoutMs: 8000, cap: 4096 }, () => finish([]));   // whole tree
  } else {
    runProc('pgrep', ['-P', String(pid)], { timeoutMs: 5000, cap: 4096 }, (r) => {
      const kids = r.code === 0 ? r.stdout.split(/\r?\n/).map((x) => parseInt(x, 10)).filter((k) => k > 1 && k !== process.pid) : [];
      finish(kids);
    });
  }
}
function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); return; } catch (e) {} }
  broadcast(msg);   // the requesting page navigated away: let whichever page is open know
}
// job-stop: reason 'user' = the reader pressed Stop (kill the assistant, then roll
// back); 'exited' = the client learnt the assistant is already gone (just roll back).
// Always answers the requester with job-stopped, even when no job was registered.
// A Stop pressed before this page's run was registered: kill the booting assistant,
// roll back NOTHING (whatever is registered belongs to another page's finished or
// still-running work).
function killOnly(ws) {
  killTermForJob(() => sendTo(ws, { type: 'job-stopped', reason: 'user', removed: [], restored: false }));
}
// The watcher saw the run's artifact land: the run is complete — drop the snapshot so
// no later Stop (from any page) can roll finished work back.
function completeJob(what) {
  if (!activeJob) return;
  console.log('  ✓ ' + activeJob.kind + ' run finished (' + what + ')');
  activeJob = null; stopJobPoll();
}
function stopJob(ws, reason) {
  const job = activeJob;
  activeJob = null;
  stopJobPoll();
  const finish = () => {
    const r = job ? rollbackJob(job) : { removed: [], restored: false };
    if (job) console.log('  • ' + job.kind + ' run stopped (' + reason + ')' +
      (r.removed.length ? ' — removed ' + r.removed.join(', ') : '') + (r.restored ? ' — digest restored' : ''));
    const reply = () => sendTo(ws, { type: 'job-stopped', reason, removed: r.removed, restored: r.restored });
    if (r.removed.length || r.restored) runBuild(reply); else reply();
  };
  // after a kill, give the process tree a moment to die so a write in flight is caught too
  if (reason === 'user') killTermForJob(() => setTimeout(finish, 700));
  else finish();
}

// Quit when the last app window goes away (after a grace period so a page reload
// or internal navigation — which briefly drops to 0 clients — doesn't kill it).
let shutdownTimer = null;
function maybeShutdown() {
  if (KEEPALIVE || clients.size > 0) return;
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    if (clients.size > 0) return;
    // A hidden run outlives the window that started it: closing the tab mid-analyze
    // used to kill the assistant and lose the report. Wait for the job to land (the
    // watcher still completes it and writes the page), then quit.
    if (activeJob) {
      console.log('  • window closed while a run is in progress — staying up until it finishes');
      return maybeShutdown();
    }
    console.log('\n  app window closed — shutting down. bye');
    killTerm();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; } // a window is back
  if (lastBuildError) {
    // the site on screen is stale — tell this page what went wrong at (re)build time
    try { ws.send(JSON.stringify({ type: 'build-error', error: lastBuildError })); } catch (e) {}
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }

    if (m.type === 'spawn') {
      if (!pty) { try { ws.send(JSON.stringify({ type: 'fatal', msg: 'node-pty is not installed; run `npm install` in workmode/ to enable the terminal.' })); } catch (e) {} return; }
      termSubs.add(ws); // this page now sees the shared shell's output
      const cols = Math.min(1000, Math.max(1, (m.cols | 0) || 80));
      const rows = Math.min(1000, Math.max(1, (m.rows | 0) || 24));
      if (!sharedTerm) {
        spawnSharedTerm(cols, rows);
      } else {
        // reattach: replay the still-running session into this fresh page, then nudge
        // a resize so full-screen TUIs (claude/codex/gemini) redraw at the new size.
        try { ws.send(JSON.stringify({ type: 'replay', data: termBuffer })); } catch (e) {}
        try { sharedTerm.resize(cols, rows); } catch (e) {}
      }
      try { ws.send(JSON.stringify({ type: 'ready' })); } catch (e) {} // ack -> client flushes pre-typed input
    } else if (m.type === 'respawn') {
      // Launching a different AI: kill the shared shell — whatever TUI is inside it —
      // and start fresh, so `codex` is never typed INTO a running `claude`.
      if (!pty) { try { ws.send(JSON.stringify({ type: 'fatal', msg: 'node-pty is not installed; run `npm install` in workmode/ to enable the terminal.' })); } catch (e) {} return; }
      termSubs.add(ws);
      const cols = Math.min(1000, Math.max(1, (m.cols | 0) || 80));
      const rows = Math.min(1000, Math.max(1, (m.rows | 0) || 24));
      if (activeJob) {
        // a registered run would die silently with the old shell — stop it properly
        // (kill its process tree, roll back, answer job-stopped) instead of orphaning it
        console.log('  • respawn while a ' + activeJob.kind + ' run is registered — stopping it first');
        stopJob(ws, 'user');
      } else {
        killTerm();
      }
      termBuffer = '';
      spawnSharedTerm(cols, rows);
      try { ws.send(JSON.stringify({ type: 'ready' })); } catch (e) {}
    } else if (m.type === 'data' && sharedTerm) {
      sharedTerm.write(m.data);
    } else if (m.type === 'resize' && sharedTerm) {
      const c = Math.min(1000, Math.max(1, m.cols | 0));
      const r = Math.min(1000, Math.max(1, m.rows | 0));
      try { sharedTerm.resize(c, r); } catch (e) {}
    } else if (m.type === 'job-start') {
      // the flow command has just been submitted to the booted assistant
      if (JOB_KINDS.indexOf(m.kind) === -1) return;
      const id = safeSlug(m.id);
      if (activeJob) console.log('  • a ' + activeJob.kind + ' run was still registered — replaced');
      const token = crypto.randomBytes(8).toString('hex');
      activeJob = { kind: m.kind, id, token, snapshot: takeJobSnapshot(m.kind, id), startedAt: new Date().toISOString(), exitAnnounced: false };
      startJobPoll();
      console.log('  • ' + m.kind + ' run started' + (id ? ' (' + id + ')' : ''));
      // the token is the page's proof it owns this run: only its holder can end or roll it back
      sendTo(ws, { type: 'job-started', kind: m.kind, id, token });
    } else if (m.type === 'job-end') {
      // the client verified the result landed
      if (activeJob && m.token === activeJob.token) completeJob('verified by the page');
    } else if (m.type === 'job-stop') {
      const reason = m.reason === 'exited' ? 'exited' : 'user';
      if (activeJob && m.token && m.token === activeJob.token) stopJob(ws, reason);
      else if (!m.token && reason === 'user') killOnly(ws);
      else sendTo(ws, { type: 'job-stopped', reason, removed: [], restored: false, stale: true });   // not this page's run
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    termSubs.delete(ws);   // detach this page; the shell keeps running for the next one
    maybeShutdown();
  });
  ws.on('error', () => {});
});

// ----------------------------------------------------------------------------
// Digest watcher -> rebuild -> push refresh
// ----------------------------------------------------------------------------
const WATCHED_NAMES = ['digest.json', 'compare.json', 'chat.json', 'dismissed.json', 'config.json', 'profile.json'];

// If `p` is exactly <base>/<slug>/<filename>, return <slug>, else null. Lets the
// watcher tell the browser which report/comparison/discussion just arrived so the
// one-click GUI flows know when to stop waiting (Analyze/Compare on a fresh `add`,
// Deep dive on a `change` to an existing digest).
function slugUnder(base, filename, p) {
  if (path.basename(p) !== filename) return null;
  const dir = path.dirname(p);
  if (path.dirname(dir) !== base) return null;
  return path.basename(dir);
}

function startWatcher() {
  // Watch DIRECTORIES (chokidar is recursive) + filter by basename, rather than
  // glob patterns — globs built with path.join use backslashes on Windows, which
  // chokidar/picomatch won't match. Directory watching behaves the same on all OSes.
  // Watch every location UNCONDITIONALLY — never sample existence at startup.
  // user/ may be created AFTER the server starts (fresh clone: the launcher or
  // /setup mkdirs it) and chokidar happily watches not-yet-existing paths;
  // sampling once froze the watch set and silently dropped config/profile/intake
  // events for the whole session. DISMISSED covers a legacy root dismissed.json
  // (a duplicate of user/ on migrated repos — chokidar dedups); ROOT_INTAKE covers
  // a legacy root .setup-intake.json.
  const targets = [REPORTS, COMPARES, CHATS, USER_DIR, DISMISSED, ROOT_INTAKE];
  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  let debounce = null;
  const trigger = (p) => {
    if (WATCHED_NAMES.indexOf(path.basename(p)) === -1) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log('  • change detected:', path.relative(REPO, p));
      runBuild();
    }, 200);
  };
  watcher.on('add', (p) => {
    let s;
    if ((s = slugUnder(REPORTS, 'digest.json', p))) {
      broadcast({ type: 'report-added', id: s });   // new paper (Analyze)
      if (activeJob && activeJob.kind === 'analyze') completeJob('reports/' + s + ' landed');
    } else if ((s = slugUnder(COMPARES, 'compare.json', p))) {
      broadcast({ type: 'compare-added', slug: s }); // new comparison (Compare)
      if (activeJob && activeJob.kind === 'compare') completeJob('compares/' + s + ' landed');
    } else if ((s = slugUnder(CHATS, 'chat.json', p))) {
      broadcast({ type: 'chat-added', slug: s });   // new discussion (Discuss)
      if (activeJob && activeJob.kind === 'discuss') completeJob('chats/' + s + ' landed');
    }
    trigger(p);
  }).on('change', (p) => {
    const s = slugUnder(REPORTS, 'digest.json', p);
    if (s) {
      broadcast({ type: 'report-changed', id: s });   // existing digest changed (Deep dive landed)
      if (activeJob && activeJob.id === s && (activeJob.kind === 'deepdive' || activeJob.kind === 'analyze')) completeJob('reports/' + s + ' rewritten');
    }
    trigger(p);
  }).on('unlink', (p) => {
    // /setup deletes the intake file as its last step — that's the "setup finished"
    // signal the app's gears overlay + terminal auto-close wait for.
    if (path.basename(p) === '.setup-intake.json') broadcast({ type: 'setup-done' });
    trigger(p);
  });
  watcher.on('error', (e) => console.error('  ! watcher error:', e.message));
  return watcher;
}

// Open a url in the system DEFAULT browser (a normal window with full chrome).
// Used for external links so they never strand the chromeless app window.
function openUrl(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    // Windows: rundll32 takes the URL as a discrete argument — `cmd /c start` would
    // let `&`, `|` or `%VAR%` inside a link cut the URL and run the remainder
    else if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch (e) { console.log('  ! could not open', url); }
}

// ----------------------------------------------------------------------------
// Open the UI in an app-mode window (chromeless), falling back to a normal tab.
// ----------------------------------------------------------------------------
function openApp(url) {
  const plat = process.platform;
  try {
    if (plat === 'darwin') {
      const apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'];
      const found = apps.find((a) =>
        fs.existsSync('/Applications/' + a + '.app') ||
        fs.existsSync(path.join(os.homedir(), 'Applications', a + '.app')));
      if (found) {
        spawn('open', ['-na', found, '--args', '--app=' + url, '--new-window'], { stdio: 'ignore', detached: true }).unref();
        return;
      }
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      return;
    }
    if (plat === 'win32') {
      const candidates = [
        process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env['ProgramFiles'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
      ];
      const exe = candidates.find((p) => p && fs.existsSync(p));
      if (exe) { spawn(exe, ['--app=' + url], { stdio: 'ignore', detached: true }).unref(); return; }
      spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
      return;
    }
    // linux & others
    const browsers = ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
    const b = browsers.map(which).find(Boolean);
    if (b) { spawn(b, ['--app=' + url], { stdio: 'ignore', detached: true }).unref(); return; }
    spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch (e) {
    console.log('  ! could not auto-open a browser — open', url, 'manually');
  }
}

// ----------------------------------------------------------------------------
// Startup: prereq checks, build once, listen (with port fallback), watch, open
// ----------------------------------------------------------------------------
function preflight() {
  console.log('\nReading Room — app server');
  console.log('  repo:   ' + REPO);
  if (!fs.existsSync(DOCS) || !fs.existsSync(path.join(DOCS, 'index.html'))) {
    console.log('  • docs/ not built yet — running the build once…');
  }
  const foundAis = ['claude', 'codex', 'gemini'].filter((c) => which(c));
  if (foundAis.length) console.log('  ✓ AI on PATH: ' + foundAis.join(', '));
  else {
    console.log('  ! no AI CLI (claude / codex / gemini) found on PATH. The integrated terminal still opens,');
    console.log('    but install one to analyze papers (e.g. Claude Code: https://docs.claude.com/en/docs/claude-code/overview).');
  }
  if (!pty) {
    console.log('  ! node-pty not installed — terminal disabled. Re-run `npm install` in workmode/.');
  }
  if (!PYTHON_OK) {
    console.log('  ! Python 3 was not found (tried python3 / python / py) — the site cannot be built until it is installed.');
  }
}

function listenWithFallback(port, triesLeft) {
  server.listen(port, HOST);
  server.once('listening', () => {
    ACTUAL_PORT = server.address().port;
    const url = 'http://' + HOST + ':' + ACTUAL_PORT + '/';
    console.log('\n  ✓ serving on ' + url + '  (loopback only)');
    console.log('    static GitHub Pages browse path is unaffected.\n');
    startWatcher();
    scheduleUpdateChecks();   // 5 s after listening, then every 6 h
    if (!NO_OPEN) openApp(url);
    else if (!KEEPALIVE) {
      // relaunched after an update with no window of our own: if the page that asked
      // for the restart never comes back (the reader closed it), don't linger as a
      // hidden zombie that the next double-click can't see
      const idleQuit = () => {
        if (clients.size > 0) return;
        // …unless a hidden run is still going (the reader closed the window and left
        // it to finish): killing it here would throw away the report being written
        if (activeJob) {
          console.log('  • no window, but a run is in progress — staying up until it finishes');
          setTimeout(idleQuit, 30000).unref();
          return;
        }
        console.log('  • no app window connected within 30 s — quitting'); killTerm(); process.exit(0);
      };
      setTimeout(() => {
        idleQuit();
      }, 30000);
    }
  });
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log('  • port ' + port + ' busy, trying ' + (port + 1) + '…');
      server.removeAllListeners('listening');
      setTimeout(() => listenWithFallback(port + 1, triesLeft - 1), 120);
    } else {
      console.error('  ✗ could not bind ' + HOST + ':' + port + ' — ' + e.message);
      console.error('    set a port with  RR_PORT=5000 npm start');
      process.exit(1);
    }
  });
}

preflight();
runBuild((code) => {
  if (code !== 0) console.log('  ! initial build had errors — serving the last good docs/ anyway.');
  listenWithFallback(WANT_PORT, 15);
});

process.on('SIGINT', () => { console.log('\n  bye'); killTerm(); process.exit(0); });
