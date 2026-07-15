#!/usr/bin/env node
'use strict';

/*
 * ensure-pty.js — runs as workmode's own `postinstall`.
 *
 * Why this exists: npm 11 added an "allow-scripts" gate that, by default, skips
 * the *install scripts of dependencies* — including node-pty's native build. The
 * result is `npm install` finishing "successfully" with no compiled terminal
 * binary, so the integrated terminal silently falls back to disabled.
 *
 * A package's OWN lifecycle scripts are not gated, so this postinstall always
 * runs. It loads node-pty; if the native binary is missing it compiles it with
 * node-gyp. It NEVER fails the install — if the toolchain is absent, the UI and
 * live rebuild still work and the server reports the terminal as disabled.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// require('node-pty') succeeds even when the native binary is missing (the addon
// loads lazily on spawn), so we confirm by actually spawning a throwaway shell.
// We run that probe in a FRESH child process every time, so the parent's module
// cache can't report a stale pass/fail across the rebuild below.
const PROBE = "var p=require('node-pty').spawn(process.platform==='win32'?'cmd.exe':'/bin/sh',[],{cols:10,rows:10});p.kill();";
function ptyWorks() {
  const r = spawnSync(process.execPath, ['-e', PROBE], { cwd: __dirname, stdio: 'ignore' });
  return r.status === 0;
}

if (ptyWorks()) { console.log('  ✓ node-pty ready (terminal enabled)'); process.exit(0); }

const ptyDir = path.join(__dirname, 'node_modules', 'node-pty');
if (!fs.existsSync(ptyDir)) {
  console.log('  ! node-pty not installed — terminal will be disabled.');
  process.exit(0);
}

const isWin = process.platform === 'win32';

// 1) Try node-pty's own prebuilt-binary fetch first — no C/C++ compiler needed
//    when a prebuilt exists for this platform + Node ABI (common on Windows/LTS).
const prebuild = path.join(ptyDir, 'scripts', 'prebuild.js');
if (fs.existsSync(prebuild)) {
  spawnSync(process.execPath, [prebuild], { cwd: ptyDir, stdio: 'ignore' });
  if (ptyWorks()) { console.log('  ✓ node-pty ready (prebuilt, terminal enabled)'); process.exit(0); }
}

// 2) Otherwise compile from source (needs a C/C++ toolchain).
console.log('  • building node-pty native module (one-time, ~30s)…');
const r = spawnSync('npx', ['--yes', 'node-gyp', 'rebuild'], {
  cwd: ptyDir, stdio: 'inherit', shell: isWin,
});

if (r.status === 0 && ptyWorks()) {
  console.log('  ✓ node-pty built (terminal enabled)');
} else {
  console.log('');
  console.log('  ! Could not build node-pty — the library, graph, and live rebuild all');
  console.log('    still work, but the integrated terminal will be disabled.');
  console.log('    Install a C/C++ toolchain and re-run `npm install` here:');
  console.log(isWin
    ? '      Windows: install "Desktop development with C++" (Visual Studio Build Tools)'
    : '      macOS:   xcode-select --install');
}
process.exit(0); // never fail the whole install over the optional terminal
