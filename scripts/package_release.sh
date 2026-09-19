#!/usr/bin/env bash
# ============================================================================
# package_release.sh — build a batteries-included Reading Room release zip.
#
# A plain source download makes the reader wait through `npm install` on first
# launch AND compile node-pty natively (Xcode Command Line Tools on macOS, VS
# Build Tools on Windows) — the most fragile step of the whole install, and the
# one the app cannot fix from inside. This packs the tracked files PLUS the
# already-built workmode/node_modules for THIS platform, so the first launch
# just opens.
#
#   bash scripts/package_release.sh            # → dist/ReadingRoom-<version>-<os>-<arch>.zip
#   bash scripts/package_release.sh --keep     # also leave the staged folder for inspection
#
# The zip has ONE top-level folder (ReadingRoom-<version>/), which is what
# scripts/update_zip.py expects from a release archive. Attach it to the GitHub
# release for the tag: the app's updater prefers the asset matching the reader's
# platform and falls back to the plain source archive when there isn't one.
#
# Reader data is never in here: only files tracked by git (git archive HEAD),
# so reports/, papers/, user/ and backups/ stay on the machine that built it.
# ============================================================================
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

command -v git >/dev/null 2>&1 || { echo "  ✗ git is required"; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "  ✗ zip is required (apt install zip / brew install zip)"; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "  ✗ not a git checkout — nothing to package"; exit 1; }

VERSION="$(tr -d ' \t\n\r' < VERSION)"
[ -n "$VERSION" ] || { echo "  ✗ VERSION is empty"; exit 1; }

# the CHANGELOG must already describe this version — the updater shows those bullets
grep -qE "^##[[:space:]]+${VERSION//./\\.}\b" CHANGELOG.md \
  || { echo "  ✗ CHANGELOG.md has no '## $VERSION' section — write it before packaging"; exit 1; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "  ! uncommitted changes — the zip is built from HEAD, so they will NOT be in it"
fi

case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *) OS="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in x86_64|amd64) ARCH="x64" ;; aarch64) ARCH="arm64" ;; esac

NAME="ReadingRoom-$VERSION"
OUT="dist/$NAME-$OS-$ARCH.zip"
STAGE="dist/.stage-$$"
rm -rf "$STAGE"; mkdir -p "$STAGE/$NAME" dist
trap 'rm -rf "$STAGE"' EXIT      # a failed run leaves no half-staged tree behind

echo "  • staging the tracked files at HEAD…"
git archive HEAD | tar -x -C "$STAGE/$NAME"

echo "  • installing the app's dependencies for ${OS}-${ARCH}…"
( cd "$STAGE/$NAME/workmode" && npm install --omit=dev --no-audit --no-fund ) >"$STAGE/install.log" 2>&1 \
  || { echo "  ✗ npm install failed — see $STAGE/install.log"; exit 1; }
( cd "$STAGE/$NAME/workmode" && node -e "require('node-pty')" ) >/dev/null 2>&1 \
  || { echo "  ✗ node-pty did not build here — the packaged app would have no terminal"; exit 1; }

# never ship someone's local state, and never a nested build
rm -rf "$STAGE/$NAME/workmode/workmode.log" "$STAGE/$NAME/workmode/workmode.pid" \
       "$STAGE/$NAME/workmode/install.log" "$STAGE/$NAME/dist" "$STAGE/$NAME/notes"

echo "  • zipping…"
rm -f "$OUT"
( cd "$STAGE" && zip -q -r -y "$REPO/$OUT" "$NAME" -x '*.DS_Store' )
[ "$KEEP" -eq 1 ] && trap - EXIT
# (no `| grep -q` here: grep exits early, unzip takes SIGPIPE, and pipefail turns a
# perfectly good zip into a failure)
LIST="$(unzip -l "$OUT")"
case "$LIST" in
  *"$NAME/VERSION"*) ;;
  *) echo "  ✗ the zip has no $NAME/VERSION — the updater would reject it"; exit 1 ;;
esac

SIZE="$(du -h "$OUT" | cut -f1)"

# release notes = this version's CHANGELOG section, ready for `gh release create -F`
NOTES="dist/notes-$VERSION.md"
awk -v v="## $VERSION" '
  $0 ~ "^## " { if (seen) exit; if (index($0, v) == 1) { seen = 1; next } }
  seen { print }
' CHANGELOG.md > "$NOTES"

echo
echo "  ✓ $OUT  ($SIZE)"
echo "  ✓ $NOTES"
echo
echo "  Publish it:"
echo "    git tag -a v$VERSION -m \"Reading Room $VERSION\" && git push origin v$VERSION"
echo "    gh release create v$VERSION \"$OUT\" --title \"Reading Room $VERSION\" -F \"$NOTES\""
echo
echo "  (the updater reads the tag for the version and prefers the asset matching the reader's platform)"
