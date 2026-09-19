#!/usr/bin/env bash
# ============================================================================
# Reading Room — Linux / Unix launcher.
#
# The twin of ReadingRoom.app (macOS) and ReadingRoom.bat (Windows): it starts
# the local server and lets the server open the app window itself. Run it from a
# file manager (double-click → "Run") or from a terminal:  ./ReadingRoom.sh
#
# INVARIANTS (shared with the other launchers — keep them):
#  * the server runs as this script's CHILD and this script waits for it;
#  * exit code 75 means "restart me" (the in-app updater installed a new
#    version) — relaunch it. Any other code ends the session;
#  * RR_LAUNCHER=1 tells the server a loop is watching, so the in-app
#    "Restart now" button is offered;
#  * user-facing text says "Reading Room" / "the app".
#
# Logs: workmode/workmode.log · pid: workmode/workmode.pid
# ============================================================================
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
cd "$REPO" || exit 1
LOG="$REPO/workmode/workmode.log"
PIDFILE="$REPO/workmode/workmode.pid"

# A double-click from a file manager has no console, so every message also goes
# to the desktop when notify-send exists. From a terminal you see both.
note() {
  printf '  %s\n' "$1"
  command -v notify-send >/dev/null 2>&1 && notify-send "Reading Room" "$1" >/dev/null 2>&1
  return 0
}
die() {
  printf '\n  ✗ %s\n\n' "$1" >&2
  command -v notify-send >/dev/null 2>&1 && notify-send -u critical "Reading Room" "$1" >/dev/null 2>&1
  # keep the window open when launched from a file manager
  [ -t 0 ] || { printf '  Press Enter to close.\n'; read -r _ || true; }
  exit 1
}

# --- Node (a desktop launch can start with a minimal PATH) ------------------
have_node() { command -v node >/dev/null 2>&1; }
if ! have_node; then
  for p in "$HOME/.local/bin" /usr/local/bin "$HOME/.volta/bin"; do
    [ -x "$p/node" ] && export PATH="$p:$PATH"
  done
  for n in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.fnm/node-versions/*/installation/bin; do
    [ -x "$n/node" ] && export PATH="$n:$PATH"
  done
fi
if ! have_node && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
fi
have_node || die "Reading Room needs Node.js 18 or newer, which was not found. Install it with your package manager (e.g. sudo apt install nodejs npm) or from nodejs.org, then run this again."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "Could not determine your Node.js version (node -v failed). Reinstall Node 18 or newer, then run this again." ;;
esac
[ "$NODE_MAJOR" -lt 18 ] && die "Reading Room needs Node.js 18 or newer — found $(node -v). Update it, then run this again."

# --- Python 3 builds the site — say so now, not as a broken page later ------
python3 --version >/dev/null 2>&1 || die "Python 3 is required but was not found. Install it (e.g. sudo apt install python3), then run this again."

# --- first run: install the server's dependencies --------------------------
LOCK="$REPO/workmode/.install.lock"
if [ ! -d "workmode/node_modules" ]; then
  if [ -f "$LOCK" ] && [ -n "$(find "$LOCK" -mmin -15 2>/dev/null)" ]; then
    note "Still setting up (first run) — the window opens when it finishes."
    exit 0
  fi
  : >"$LOCK"
  note "First-run setup (about a minute) — the window opens when it is ready."
  ( cd workmode && npm install --no-audit --no-fund ) >"$REPO/workmode/install.log" 2>&1
  RC=$?
  rm -f "$LOCK"
  [ "$RC" -ne 0 ] && die "Installing Reading Room's dependencies failed. See workmode/install.log for details."
  # node-pty is native: if npm's script policy skipped its build, the app would
  # open with a dead terminal — rebuild it explicitly in that case.
  if ! ( cd workmode && node -e "require('node-pty')" ) >/dev/null 2>&1; then
    ( cd workmode && npm rebuild node-pty ) >>"$REPO/workmode/install.log" 2>&1
  fi
fi

# --- already running? its window is open; nothing to do --------------------
OLDPID="$(cat "$PIDFILE" 2>/dev/null || true)"
if [ -n "${OLDPID:-}" ] && ps -p "$OLDPID" -o args= 2>/dev/null | grep -q "server\.js"; then
  note "Reading Room is already running."
  exit 0
fi

# --- first run only: offer a desktop entry ---------------------------------
# A .desktop file must carry an absolute path, so it can only be written here,
# on this machine. One-shot, whatever the answer (same marker the other launchers use).
offer_desktop_entry() {
  MARKER="$REPO/user/.desktop-shortcut-offered"
  [ -f "$MARKER" ] && return 0
  mkdir -p "$REPO/user" && : >"$MARKER"
  APPS="$HOME/.local/share/applications"
  ENTRY="$APPS/reading-room.desktop"
  [ -e "$ENTRY" ] && return 0
  mkdir -p "$APPS" 2>/dev/null || return 0
  {
    printf '[Desktop Entry]\nType=Application\nName=Reading Room\n'
    printf 'Comment=Your own reading room for papers\n'
    printf 'Exec=%s/ReadingRoom.sh\nPath=%s\nTerminal=false\nCategories=Education;Science;\n' "$REPO" "$REPO"
    [ -f "$REPO/assets/reading-room-logo.png" ] && printf 'Icon=%s/assets/reading-room-logo.png\n' "$REPO"
  } >"$ENTRY" 2>/dev/null || return 0
  chmod +x "$ENTRY" 2>/dev/null
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1
  note "Added Reading Room to your applications menu."
}

cd "$REPO/workmode" || die "Part of the app is missing (the workmode/ folder). Download Reading Room again."

RESTARTED=0
export RR_LAUNCHER=1          # a loop is watching: the in-app "Restart now" is offered
trap 'rm -f "$PIDFILE"' EXIT
while :; do
  if [ "$RESTARTED" -eq 0 ]; then
    node server.js >"$LOG" 2>&1 &
  else
    RR_NO_OPEN=1 node server.js >"$LOG" 2>&1 &   # the page that asked reloads itself
  fi
  SRV=$!
  echo "$SRV" >"$PIDFILE"

  sleep 3
  if ! kill -0 "$SRV" 2>/dev/null; then
    wait "$SRV"; RC=$?
    if [ "$RC" -eq 75 ]; then RESTARTED=1; note "Update installed — restarting…"; continue; fi
    ERR="$(tail -n 3 "$LOG" 2>/dev/null)"
    die "Reading Room failed to start.

$ERR

Full log: workmode/workmode.log"
  fi

  [ "$RESTARTED" -eq 0 ] && offer_desktop_entry

  wait "$SRV"
  RC=$?
  [ "$RC" -eq 75 ] || break                     # 75 = "restart me" (in-app update)
  RESTARTED=1
  note "Update installed — restarting…"
done
rm -f "$PIDFILE"
exit 0
