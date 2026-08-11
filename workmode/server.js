#!/usr/bin/env node
'use strict';

/*
 * Reading Room — work-mode server.
 *
 * Serves the EXISTING static site (docs/) on loopback only and layers on the
 * "work mode" affordances without touching the static build:
 *   • static-serves docs/ exactly as built (relative paths -> served unchanged);
 *   • for .html responses, injects (in memory, on the fly) a small work-mode
 *     client — the on-disk docs/ stays byte-identical, so GitHub Pages is never
 *     affected;
 *   • a WebSocket bridge spawns your $SHELL via node-pty in the repo root for an
 *     integrated terminal (you run an AI — claude / codex / gemini — and
 *     `/explain-paper` yourself; this never bypasses the AI's permission prompts);
 *   • a chokidar watcher on reports/ (+ compares/ + dismissed.json) re-runs the
 *     EXISTING `python scripts/build.py` when a digest changes and pushes a refresh to
 *     the browser (it watches files — it does NOT parse terminal output);
 *   • small local API routes that call the existing build step and persist
 *     ghost dismissals to dismissed.json.
 *
 * SECURITY: binds to 127.0.0.1 only. Because it exposes a shell, it must never be
 * reachable from the network. No CORS is enabled; the WS shares the loopback
 * HTTP server.
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
  console.error('\n  ✗ Work-mode dependencies are not installed.');
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

// A stable id for THIS INSTALLATION, so the client can scope per-copy browser state
// (the first-run tutorial flag) even under work mode — where every copy is served
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
const SHUTDOWN_GRACE_MS = parseInt(process.env.RR_SHUTDOWN_GRACE_MS || '5000', 10);

let ACTUAL_PORT = WANT_PORT; // updated once we actually bind

// Vendored browser assets (served from node_modules so work mode is offline).
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
  for (const c of ['python3', 'python']) {
    try {
      const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (r.status === 0) return c;
    } catch (e) {}
  }
  return 'python3';
}

const PY = pythonCmd();

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

function runBuild(cb) {
  if (cb) buildCbs.push(cb);
  if (building) { buildQueued = true; return; } // a fresh build runs after this one
  building = true;
  broadcast({ type: 'building' });
  const child = spawn(PY, ['scripts/build.py'], { cwd: REPO });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-8000); }); // cap as we append
  child.stdout.on('data', () => {}); // drain to avoid backpressure stalls
  const finish = (code, startupErr) => {
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
// HTML interception: inject the work-mode client before </body> (in memory)
// ----------------------------------------------------------------------------
function workmodeSnippet() {
  return [
    '<!-- Reading Room work mode (injected by the local server; NOT in docs/ on disk) -->',
    '<link rel="stylesheet" href="/__workmode/vendor/xterm.css">',
    '<link rel="stylesheet" href="/__workmode/workmode.css">',
    '<script>window.RR_WORKMODE = { ws: "/__workmode/ws", port: ' + ACTUAL_PORT + ', root: "' + REPO_KEY + '" };</script>',
    '<script src="/__workmode/vendor/xterm.js"></script>',
    '<script src="/__workmode/vendor/addon-fit.js"></script>',
    '<script src="/__workmode/workmode.js"></script>',
  ].join('\n');
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
  return i !== -1 ? html.slice(0, i) + snip + '\n' + html.slice(i) : html + snip;
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
app.use(express.json({ limit: '256kb' }));

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
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (isLoopbackHost(req.headers.host) && isLoopbackOrigin(req.headers.origin)) return next();
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

// Stream an arXiv PDF through the local origin so it can be shown INSIDE the app
// (an iframe straight to arxiv.org would be blocked by X-Frame-Options and would
// strand the chromeless window). The host is hardcoded to arXiv and the id is
// shape-validated, so this is not an open proxy.
app.get('/pdf', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const okNew = /^\d{4}\.\d{4,5}(v\d+)?$/.test(id);
  const okOld = /^[a-z-]+(\.[a-z]{2})?\/\d{7}(v\d+)?$/i.test(id);
  if (!okNew && !okOld) return res.status(400).send('bad arXiv id');

  // reuse a locally downloaded copy if present (e.g. fetched by /explain-paper)
  const local = path.join(PAPERS, path.basename(id.replace(/\//g, '-')) + '.pdf');
  if (fs.existsSync(local)) { res.type('application/pdf'); return res.sendFile(local); }

  try {
    const up = await fetch('https://arxiv.org/pdf/' + id, { headers: { 'User-Agent': 'ReadingRoom/1.0 (local work mode)' } });
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

// --- work-mode client (css/js) ---
app.use('/__workmode', express.static(CLIENT));

// --- HTML pages: inject the work-mode client on the fly ---
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
  // website the user visits while work mode runs could open this socket, spawn the
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

// Quit when the last app window goes away (after a grace period so a page reload
// or internal navigation — which briefly drops to 0 clients — doesn't kill it).
let shutdownTimer = null;
function maybeShutdown() {
  if (KEEPALIVE || clients.size > 0) return;
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    if (clients.size === 0) {
      console.log('\n  app window closed — shutting down. bye');
      killTerm();
      process.exit(0);
    }
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
      killTerm();
      termBuffer = '';
      spawnSharedTerm(cols, rows);
      try { ws.send(JSON.stringify({ type: 'ready' })); } catch (e) {}
    } else if (m.type === 'data' && sharedTerm) {
      sharedTerm.write(m.data);
    } else if (m.type === 'resize' && sharedTerm) {
      const c = Math.min(1000, Math.max(1, m.cols | 0));
      const r = Math.min(1000, Math.max(1, m.rows | 0));
      try { sharedTerm.resize(c, r); } catch (e) {}
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
    if ((s = slugUnder(REPORTS, 'digest.json', p))) broadcast({ type: 'report-added', id: s });   // new paper (Analyze)
    else if ((s = slugUnder(COMPARES, 'compare.json', p))) broadcast({ type: 'compare-added', slug: s }); // new comparison (Compare)
    else if ((s = slugUnder(CHATS, 'chat.json', p))) broadcast({ type: 'chat-added', slug: s });   // new discussion (Discuss)
    trigger(p);
  }).on('change', (p) => {
    const s = slugUnder(REPORTS, 'digest.json', p);
    if (s) broadcast({ type: 'report-changed', id: s });   // existing digest changed (Deep dive landed)
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
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
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
  console.log('\nReading Room — work mode');
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
}

function listenWithFallback(port, triesLeft) {
  server.listen(port, HOST);
  server.once('listening', () => {
    ACTUAL_PORT = server.address().port;
    const url = 'http://' + HOST + ':' + ACTUAL_PORT + '/';
    console.log('\n  ✓ serving on ' + url + '  (loopback only)');
    console.log('    static GitHub Pages browse path is unaffected.\n');
    startWatcher();
    if (!NO_OPEN) openApp(url);
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
