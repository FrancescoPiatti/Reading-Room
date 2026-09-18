#!/usr/bin/env python3
"""update_zip.py — apply a downloaded release zip to this Reading Room copy IN PLACE.

For copies that were downloaded as a ZIP (no .git), the app's updater fetches the
repository's branch archive from GitHub and hands it here. This script:
  1. reads the archive (one top-level folder, e.g. Reading-Room-main/),
  2. copies every APP file over the current copy — code, templates, scripts,
     launchers, commands, assets, docs/ — overwriting what changed,
  3. never touches the reader's data: reports/ compares/ chats/ user/ papers/
     backups/ and workmode/node_modules/ are skipped entirely,
  4. prints a JSON summary: which files changed, whether workmode/ (a restart)
     or workmode/package*.json (an npm install) or UPGRADING.md changed.

Pure stdlib. Safe against zip-slip (absolute / .. entries, symlinks are skipped).

Usage:
  python scripts/update_zip.py APPLY.zip [--root REPO_ROOT] [--dry-run]
"""
import argparse
import json
import posixpath
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# the reader's data + local runtime state: never written by an update
PROTECTED_TOPS = {"reports", "compares", "chats", "user", "papers", "backups", ".git"}
PROTECTED_PREFIXES = ("workmode/node_modules/",)
PROTECTED_FILES = {"workmode/workmode.log", "workmode/workmode.pid", "workmode/install.log",
                   ".setup-intake.json", "profile.json", "config.json", "dismissed.json"}


def _members(zf):
    """Yield (ZipInfo, repo-relative posix path) for safe, in-scope app files."""
    names = [i.filename for i in zf.infolist() if not i.filename.endswith("/")]
    if not names:
        return
    # GitHub archives wrap everything in "<repo>-<branch>/"; strip that one folder
    tops = {n.split("/", 1)[0] for n in names}
    prefix = (tops.pop() + "/") if len(tops) == 1 and all("/" in n for n in names) else ""
    for info in zf.infolist():
        name = info.filename
        if name.endswith("/") or (prefix and not name.startswith(prefix)):
            continue
        if (info.external_attr >> 16) & 0o170000 == 0o120000:      # symlink
            continue
        rel = posixpath.normpath(name[len(prefix):])
        if rel.startswith("/") or rel == ".." or rel.startswith("../") or "/../" in rel or rel == ".":
            continue
        top = rel.split("/", 1)[0]
        if top in PROTECTED_TOPS or rel in PROTECTED_FILES or rel.startswith(PROTECTED_PREFIXES):
            continue
        yield info, rel


def apply(zip_path: Path, root: Path, dry_run: bool = False) -> dict:
    changed, added, unchanged = [], [], 0
    with zipfile.ZipFile(zip_path) as zf:
        members = list(_members(zf))
        if not members:
            raise SystemExit("  ✗ the archive holds no app files (not a Reading Room release zip?)")
        rels = {rel for _, rel in members}
        if "scripts/build.py" not in rels or "VERSION" not in rels:
            raise SystemExit("  ✗ the archive doesn't look like a Reading Room release (scripts/build.py / VERSION missing)")
        for info, rel in members:
            dest = root / rel
            data = zf.read(info)
            if dest.exists():
                try:
                    same = dest.read_bytes() == data
                except OSError:
                    same = False
                if same:
                    unchanged += 1
                    continue
                changed.append(rel)
            else:
                added.append(rel)
            if dry_run:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + ".rr-new")
            tmp.write_bytes(data)
            # keep executable bits from the archive (launcher scripts) — zip stores them in external_attr
            mode = (info.external_attr >> 16) & 0o777
            if mode:
                try:
                    tmp.chmod(mode | 0o600)
                except OSError:
                    pass
            tmp.replace(dest)
    touched = changed + added
    return {
        "changed": changed,
        "added": added,
        "unchanged": unchanged,
        "restartNeeded": any(p.startswith("workmode/") for p in touched),
        "installNeeded": any(p in ("workmode/package.json", "workmode/package-lock.json") for p in touched),
        "upgradingChanged": "UPGRADING.md" in touched,
        "dryRun": dry_run,
    }


def main():
    ap = argparse.ArgumentParser(description="Apply a Reading Room release zip over this copy (data untouched).")
    ap.add_argument("zip")
    ap.add_argument("--root", default=str(ROOT), help="repo root to update (default: this checkout)")
    ap.add_argument("--dry-run", action="store_true", help="report what would change without writing")
    args = ap.parse_args()
    zp = Path(args.zip)
    if not zp.exists():
        raise SystemExit(f"  ✗ no such file: {zp}")
    result = apply(zp, Path(args.root).resolve(), args.dry_run)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
