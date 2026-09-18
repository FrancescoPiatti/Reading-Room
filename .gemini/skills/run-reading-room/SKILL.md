---
name: run-reading-room
description: "Run, launch, smoke-test, screenshot, or drive the Reading Room app (its local server + static site). Use when you need to start the local server, take a screenshot of any page, run a command in the app's integrated terminal, health-check the API/WS guards, or verify a UI change actually renders — without opening a window on the user's screen."
---

# Run Reading Room

Reading Room is a static site (`docs/`) plus a loopback-only Node server
(`workmode/`) that adds an integrated AI terminal and live rebuilds. The
launchers (`ReadingRoom.app`/`.bat`) are for humans; **agents drive everything
through the driver**, which never opens a window. All paths below are relative
to the repo root.

## Prerequisites

- Node 18+ and `workmode/node_modules` installed (`cd workmode && npm install` — needed once).
- Python 3.8+ (the build; stdlib only).
- Google Chrome at `/Applications/Google Chrome.app` (screenshots only).

## Run (agent path)

```bash
node .gemini/skills/run-reading-room/driver.mjs serve            # start headless; prints http://127.0.0.1:<port>/
node .gemini/skills/run-reading-room/driver.mjs smoke            # 5 health+security checks (exit 0 = all pass)
node .gemini/skills/run-reading-room/driver.mjs term 'echo hi'   # run a shell command in the app's shared pty
node .gemini/skills/run-reading-room/driver.mjs shot papers/hornik1989/ out.png 8000   # CDP screenshot (waitMs last)
node .gemini/skills/run-reading-room/driver.mjs shot / out.png                          # catalogue
node .gemini/skills/run-reading-room/driver.mjs build            # python3 scripts/verify.py --build (build + QA)
node .gemini/skills/run-reading-room/driver.mjs stop
```

- `serve` sets `RR_NO_OPEN=1` (no browser window) and `RR_KEEPALIVE=1`
  (otherwise the server auto-quits seconds after the last client disconnects
  — a curl-only session kills it between commands). State (pid/port/log) is
  kept in the OS tmpdir; `serve` is idempotent.
- `shot` also accepts absolute `file://` or `http(s)://` URLs (use `file://`
  for the static-docs behavior of a page). Give MathJax-heavy pages `8000` ms.
- `shot` emulates a **1200×800 viewport at 2× device scale** (a 2400×1600 PNG —
  retina-crisp, the size the tutorial/README figures are captured at). Override
  per run with the env vars `RR_SHOT_W`, `RR_SHOT_H`, `RR_SHOT_SCALE`, e.g.
  `RR_SHOT_SCALE=1 node … shot / out.png` for a quick 1:1 check, or
  `RR_SHOT_H=1600` for a tall page (the PNG is always `W×scale` by `H×scale`).
- `term` uses the real WS protocol with a fresh pty (`respawn`), so it never
  types into a TUI another session left running.

## Direct invocation (most changes need only this)

Template/build/digest changes don't need the server at all:

```bash
python3 scripts/verify.py --build     # rebuild docs/ + full QA — fix ✗ before shipping
```

Then screenshot the affected page via `shot` to confirm it renders (the
feedback rule for this repo: render and look before claiming done).

## Run (human path)

Double-click `ReadingRoom.app` (macOS) / `ReadingRoom.bat` (Windows), or
`cd workmode && npm start` for foreground logs. Both open an app window —
don't use them from an agent session. macOS gotchas (Gatekeeper, TCC,
OneDrive eviction) are documented in README → "macOS first-launch notes".

## Gotchas (all hit for real)

- **The WS terminal is guarded twice**: it lives at path `/__workmode/ws`
  (anything else → 400) and rejects upgrades whose `Origin` header isn't the
  server's own loopback origin *with the right port* (→ 401). Same for
  state-changing `POST /api/*` (→ 403). That's the anti-drive-by-RCE design —
  send `Origin: http://127.0.0.1:<port>` from test clients.
- **Port is not fixed**: 4317, falling back to 4318+ if busy. Never hardcode;
  the driver probes 4317–4326.
- **An empty server log does not mean "not started"** — node fully buffers
  stdout to files. Probe the port instead (startup also rebuilds docs/, which
  takes seconds).
- **`--virtual-time-budget` screenshots hang** on the app's pages (the open
  WebSocket never lets virtual time settle) and on MathJax pages. Use the
  driver's CDP path with real waits.
- **A fresh browser profile auto-opens the tutorial modal** over every page,
  and closing it chains into the Setup modal — the driver closes both before
  capturing. The seen-flag key is per-copy: `rr-tutorial-seen@<site-root-path>`.
- **The pty shell sources the user's rc files** (conda etc.) — a command typed
  in the first ~2 s can land before the shell is ready. The driver waits.
- **macOS has no `timeout` command**; don't write shell tests that rely on it.
- If the repo lives in OneDrive/CloudStorage and file reads hang or EPERM:
  cloud-evicted placeholders — `find . -type f -exec cat {} + >/dev/null`
  re-hydrates (see README).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ws error Unexpected server response: 400` | You hit `/` — the WS path is `/__workmode/ws`. |
| `… response: 401` on WS | Missing/wrong `Origin` header (must be the server's own loopback origin, port included). |
| `HTTP 000` right after starting the server | Startup rebuild still running — wait; the driver polls up to 60 s. |
| Server gone between two commands | It auto-quit without clients. Use the driver's `serve` (`RR_KEEPALIVE=1`). |
| Screenshot is the tutorial modal | You bypassed the driver; it closes tutorial + setup first. |
| `node-pty is not installed` in the terminal | `cd workmode && npm install` (approve node-pty's build scripts if npm asks). |
