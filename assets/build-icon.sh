#!/bin/bash
# build-icon.sh (macOS) — build ReadingRoom.icns from assets/reading-room-logo.png
# and install it into the ReadingRoom.app bundle.
#
# Re-run this if the icon ever disappears (e.g. after a cloud-sync round-trip that
# strips extended attributes / repackages the bundle):  bash assets/build-icon.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PNG="$DIR/reading-room-logo.png"
ICNS="$DIR/ReadingRoom.icns"
APP="$DIR/../ReadingRoom.app"

[ -f "$PNG" ] || { echo "  ✗ missing $PNG — run: python3 \"$DIR/make_logo.py\""; exit 1; }

# build a multi-resolution .icns
TMP="$(mktemp -d)"; ISET="$TMP/icon.iconset"; mkdir -p "$ISET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$PNG" --out "$ISET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z "$d" "$d" "$PNG" --out "$ISET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ISET" -o "$ICNS"
rm -rf "$TMP"

# ReadingRoom.app — the proper bundle icon (no resource fork needed). Also restore
# the executable bit, which a cloud-sync round-trip (OneDrive) can strip.
if [ -d "$APP" ]; then
  mkdir -p "$APP/Contents/Resources"
  cp "$ICNS" "$APP/Contents/Resources/ReadingRoom.icns"
  chmod +x "$APP/Contents/MacOS/ReadingRoom" 2>/dev/null || true
  touch "$APP"
  echo "  ✓ icon installed into ReadingRoom.app (+ exec bit restored)"
fi

echo "  ✓ icon built ($ICNS)"
