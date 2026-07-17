#!/usr/bin/env node
/* ============================================================================
   driver.mjs — programmatic harness for Reading Room's work-mode app.

   Agents use THIS (not the double-click launcher) to run and drive the app:
     node .agents/skills/run-reading-room/driver.mjs serve          # start headless, print URL
     node .agents/skills/run-reading-room/driver.mjs smoke          # health + security checks
     node .agents/skills/run-reading-room/driver.mjs term 'echo hi' # run a command in the app's pty
     node .agents/skills/run-reading-room/driver.mjs shot / out.png # CDP screenshot (closes the tutorial first)
     node .agents/skills/run-reading-room/driver.mjs stop

   No window ever opens (RR_NO_OPEN=1); the server survives idle periods
   (RR_KEEPALIVE=1 — without it, it auto-quits seconds after the last client
   disconnects, which kills curl-only sessions). State lives in the OS tmpdir.
   ============================================================================ */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STATE = path.join(os.tmpdir(), 'rr-driver-state.json');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadWs() {
  try { return createRequire(import.meta.url)(path.join(REPO, 'workmode', 'node_modules', 'ws')); }
  catch (e) { die('the ws module is missing — run:  cd workmode && npm install'); }
}
function die(msg) { console.error('✗ ' + msg); process.exit(1); }
function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return null; } }

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return r.status === 200;
  } catch (e) { return false; }
}
async function findServer() {
  const st = readState();
  if (st && (await probe(st.port))) return st;
  for (let p = 4317; p <= 4326; p++) if (await probe(p)) return { port: p, pid: null };
  return null;
}

async function serve() {
  const existing = await findServer();
  if (existing) { console.log(`already serving on http://127.0.0.1:${existing.port}/`); return existing; }
  const log = path.join(os.tmpdir(), 'rr-driver-server.log');
  const child = spawn('node', ['server.js'], {
    cwd: path.join(REPO, 'workmode'),
    env: { ...process.env, RR_NO_OPEN: '1', RR_KEEPALIVE: '1' },
    detached: true,
    stdio: ['ignore', fs.openSync(log, 'w'), fs.openSync(log, 'a')],
  });
  child.unref();
  // NOTE: node fully buffers stdout to a file — an empty log does NOT mean "not
  // started". Probe the ports instead (startup rebuilds docs/, so allow ~60s).
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    for (let p = 4317; p <= 4326; p++) {
      if (await probe(p)) {
        const st = { pid: child.pid, port: p, log };
        fs.writeFileSync(STATE, JSON.stringify(st));
        console.log(`serving on http://127.0.0.1:${p}/  (pid ${child.pid}, log ${log})`);
        return st;
      }
    }
  }
  die(`server did not come up in 60s — see ${log}`);
}

function stop() {
  const st = readState();
  if (st && st.pid) { try { process.kill(st.pid); console.log(`stopped pid ${st.pid}`); } catch (e) { console.log('pid already gone'); } }
  spawnSync('pkill', ['-f', 'node server.js']);
  try { fs.unlinkSync(STATE); } catch (e) {}
  console.log('stopped');
}

/* Run one shell command in the app's shared pty over the real WS protocol.
   The WS lives at PATH /__workmode/ws and REJECTS upgrades whose Origin isn't
   the server's own loopback origin (right port included) — that's the anti-RCE
   guard, not a bug. The pty shell sources the user's rc files, which can take
   seconds, so we wait for output to go quiet rather than a fixed delay. */
async function term(cmd, waitMs = 12000) {
  const st = await findServer(); if (!st) die('no server — run `serve` first');
  const WebSocket = loadWs();
  const origin = `http://127.0.0.1:${st.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${st.port}/__workmode/ws`, { headers: { origin } });
  let out = '';
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => resolve(), waitMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'respawn', cols: 120, rows: 32 })));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'data' || m.type === 'replay') out += m.data;
      if (m.type === 'ready') setTimeout(() => ws.send(JSON.stringify({ type: 'data', data: cmd + '\r' })), 2500);
    });
    ws.on('error', (e) => { clearTimeout(deadline); reject(e); });
  }).catch((e) => die('ws failed: ' + e.message));
  ws.close();
  // strip ANSI escapes for readable output
  console.log(out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]/g, ''));
}

/* CDP screenshot. Handles the two things that break naive headless shots:
   (1) --virtual-time-budget never settles on the work-mode page (open WS) and
       hangs with MathJax — so we use real waits over the devtools protocol;
   (2) a fresh profile auto-opens the tutorial modal over everything, and
       closing it chains into Setup — so we close both before capturing. */
async function shot(target, out, waitMs = 5000) {
  if (!fs.existsSync(CHROME)) die('Google Chrome not found at the expected macOS path');
  let url = target;
  if (!/^(https?|file):/.test(target)) {
    const st = await findServer(); if (!st) die('no server — run `serve` first (or pass a file:// url)');
    url = `http://127.0.0.1:${st.port}/${target.replace(/^\//, '')}`;
  }
  const WebSocket = loadWs();
  const dbgPort = 9222 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-shot-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`,
    '--window-size=1280,1500', `--remote-debugging-port=${dbgPort}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 20 && !wsUrl; i++) {
    await sleep(1000);
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json();
      wsUrl = (list.find((t) => t.type === 'page') || {}).webSocketDebuggerUrl;
    } catch (e) {}
  }
  if (!wsUrl) { chrome.kill(); die('chrome devtools endpoint never came up'); }
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res) => { const m = ++id; pending.set(m, res); ws.send(JSON.stringify({ id: m, method, params })); });
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m); pending.delete(m.id); } });
  const evaljs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
  await new Promise((r) => ws.on('open', r));
  await send('Page.enable');
  await send('Page.navigate', { url });
  await sleep(1500);
  await evaljs(`(function(){var x=document.querySelector('#rr-tutorial-modal .rr-modal-x'); if(x&&!document.getElementById('rr-tutorial-modal').hasAttribute('hidden')) x.click();})()`);
  await sleep(500); // closing the tutorial chains into Setup — close that too
  await evaljs(`(function(){var x=document.querySelector('#rr-setup-modal .rr-modal-x'); if(x&&!document.getElementById('rr-setup-modal').hasAttribute('hidden')) x.click();})()`);
  await sleep(waitMs);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  const gone = new Promise((res) => chrome.on('exit', res));
  chrome.kill();
  await Promise.race([gone, sleep(3000)]);          // let Chrome release the profile
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} // tmpdir — best effort
  console.log('saved ' + out);
}

/* Health + security smoke against the running server. */
async function smoke() {
  const st = await findServer(); if (!st) die('no server — run `serve` first');
  const base = `http://127.0.0.1:${st.port}`;
  let pass = true;
  const check = (ok, label) => { console.log((ok ? '✓' : '✗') + ' ' + label); if (!ok) pass = false; };

  const home = await fetch(`${base}/`);
  check(home.status === 200 && (await home.text()).length > 1000, 'GET / serves the catalogue');

  const rid = fs.readdirSync(path.join(REPO, 'reports')).find((d) => fs.existsSync(path.join(REPO, 'reports', d, 'digest.json')));
  if (rid) {
    const n = await (await fetch(`${base}/api/notes?id=${rid}`)).json();
    check(n.ok === true, `GET /api/notes?id=${rid} answers`);
  }
  const evil = await fetch(`${base}/api/dismiss`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"id":"x"}' });
  check(evil.status === 403, 'POST with foreign Origin is refused (403)');

  const WebSocket = loadWs();
  const bad = new WebSocket(`ws://127.0.0.1:${st.port}/__workmode/ws`); // no Origin header
  const badRejected = await new Promise((r) => { bad.on('open', () => r(false)); bad.on('error', () => r(true)); });
  check(badRejected, 'WS upgrade without loopback Origin is refused');

  const good = new WebSocket(`ws://127.0.0.1:${st.port}/__workmode/ws`, { headers: { origin: base } });
  const goodOk = await new Promise((r) => {
    const t = setTimeout(() => r(false), 5000);
    good.on('open', () => good.send(JSON.stringify({ type: 'spawn', cols: 80, rows: 24 })));
    good.on('message', (d) => { if (JSON.parse(d).type === 'ready') { clearTimeout(t); r(true); } });
    good.on('error', () => { clearTimeout(t); r(false); });
  });
  good.close();
  check(goodOk, 'WS terminal attaches with the right Origin');

  process.exit(pass ? 0 : 1);
}

function build() {
  const r = spawnSync('python3', ['verify.py', '--build'], { cwd: REPO, encoding: 'utf8' });
  const tail = (r.stdout || '').trim().split('\n').slice(-3).join('\n');
  console.log(tail || r.stderr);
  process.exit(r.status || 0);
}

const [, , cmd, ...args] = process.argv;
if (cmd === 'serve') await serve();
else if (cmd === 'stop') stop();
else if (cmd === 'smoke') await smoke();
else if (cmd === 'term') await term(args.join(' ') || 'echo no command given', Number(process.env.RR_TERM_WAIT) || undefined);
else if (cmd === 'shot') await shot(args[0] || '/', args[1] || 'shot.png', Number(args[2]) || undefined);
else if (cmd === 'build') build();
else die('usage: driver.mjs serve | smoke | term <cmd> | shot <page|url> <out.png> [waitMs] | build | stop');

