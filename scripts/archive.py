#!/usr/bin/env python3
"""archive.py — back up / restore all Reading Room user data as a single zip.

Pure stdlib (matches build.py / verify.py). Bundles everything the reader owns:
  reports/   digests + your notes.md          (analysed papers)
  compares/  side-by-side comparisons
  chats/     compacted /learn discussions
  user/      profile.json, config.json, dismissed.json (+ reading-state.json if you saved one)
  papers/    downloaded PDFs                   (optional; --no-pdfs to skip)

The generated docs/ site is NOT included — it's fully rebuildable with `python scripts/build.py`.
Your status/priority *stars* live in the browser (localStorage), not on disk, so they are
not in this zip — export those from the header avatar menu → "Back up".

Usage:
  python scripts/archive.py export [-o OUT.zip] [--no-pdfs]
  python scripts/archive.py import BACKUP.zip [--replace] [--no-backup] [--force]
  python scripts/archive.py list BACKUP.zip

`import` merges by default (files in the zip are written over/added; nothing else is
deleted) and first writes a safety snapshot of your current data to backups/. Use
--replace for an exact restore (wipes the data dirs the zip covers, then extracts).
"""
import argparse
import datetime
import json
import posixpath
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent   # scripts/ -> repo root
BACKUPS = ROOT / "backups"

# top-level dirs holding user-owned data (docs/ is generated → rebuilt, never backed up)
DATA_DIRS = ["reports", "compares", "chats", "user"]
PDF_DIR = "papers"
ALLOWED_TOPS = set(DATA_DIRS + [PDF_DIR])
MANIFEST = "manifest.json"
FORMAT_VERSION = 1
# transient / noise never worth archiving
# .install-id identifies THIS install (per-copy tutorial flag) and .desktop-shortcut-offered
# is a per-machine one-shot marker — neither belongs in a backup that may be restored elsewhere.
SKIP_NAMES = {".DS_Store", ".setup-intake.json", ".install-id", ".desktop-shortcut-offered"}


def _ignored(p: Path) -> bool:
    return "__pycache__" in p.parts or p.name in SKIP_NAMES


def _counts() -> dict:
    def n(glob):
        parts = glob.split("/")
        base = ROOT / parts[0]
        return len(list(base.glob("/".join(parts[1:])))) if base.exists() else 0
    return {
        "reports": n("reports/*/digest.json"),
        "comparisons": n("compares/*/compare.json"),
        "discussions": n("chats/*/chat.json"),
        "pdfs": n("papers/*.pdf"),
    }


def _iter_files(include_pdfs: bool):
    for d in DATA_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and not p.is_symlink() and not _ignored(p):
                yield p
    if include_pdfs and (ROOT / PDF_DIR).exists():
        # keep the dir's .gitkeep so an empty papers/ still restores, plus the PDFs
        for p in sorted((ROOT / PDF_DIR).iterdir()):
            if p.is_file() and not p.is_symlink() and (p.suffix.lower() == ".pdf" or p.name == ".gitkeep"):
                yield p


def do_export(out_path=None, include_pdfs=True):
    counts = _counts()
    if not include_pdfs:
        counts["pdfs"] = 0                      # counts reflect what's actually in the zip
    if out_path is None:
        BACKUPS.mkdir(exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = BACKUPS / f"reading-room-backup-{stamp}.zip"
    else:
        out_path = Path(out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "tool": "reading-room",
        "format": FORMAT_VERSION,
        "created": datetime.datetime.now().isoformat(timespec="seconds"),
        "includes_pdfs": include_pdfs,
        "counts": counts,
    }
    # write to a temp name and rename at the end, so an aborted export never leaves a
    # truncated zip under the final name (or clobbers a previous good one)
    part = out_path.with_name(out_path.name + ".part")
    with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(MANIFEST, json.dumps(manifest, indent=2) + "\n")
        for f in _iter_files(include_pdfs):
            try:
                zf.write(f, arcname=f.relative_to(ROOT).as_posix())
            except OSError as e:
                # a cloud-evicted ("dataless") file in OneDrive/iCloud times out on read;
                # a silent skip would ship an incomplete backup, so stop with a clear message
                zf.close()
                part.unlink(missing_ok=True)
                raise SystemExit(f"  ✗ could not read {f.relative_to(ROOT).as_posix()} ({e.strerror or e}). "
                                 "If this folder is cloud-synced, make the file available offline "
                                 "(\"Always Keep on This Device\") and export again.")
    part.replace(out_path)
    return out_path, manifest


def _read_manifest(zf):
    try:
        return json.loads(zf.read(MANIFEST))
    except Exception:
        return None


def _safe_targets(zf):
    """Yield (ZipInfo, relative_posix) only for members safe to extract.

    Guards against zip-slip (absolute / .. paths), symlinks, and anything outside
    the known top-level data dirs."""
    for info in zf.infolist():
        name = info.filename
        if name.endswith("/") or name == MANIFEST:
            continue
        if (info.external_attr >> 16) & 0o170000 == 0o120000:  # S_IFLNK
            print(f"  ! skipped symlink entry: {name}", file=sys.stderr)
            continue
        norm = posixpath.normpath(name)
        if norm.startswith("/") or norm == ".." or norm.startswith("../") or "/../" in norm:
            print(f"  ! skipped unsafe path: {name}", file=sys.stderr)
            continue
        top = norm.split("/", 1)[0]
        if top not in ALLOWED_TOPS:
            print(f"  ! skipped out-of-scope entry: {name}", file=sys.stderr)
            continue
        yield info, norm


def _wipe_contents(d: Path):
    if not d.exists():
        return
    for child in d.iterdir():
        # .gitkeep keeps the dir; SKIP_NAMES are per-install markers (install id, shortcut
        # offer) that no backup carries — wiping them would re-run the first-run flow
        if child.name == ".gitkeep" or child.name in SKIP_NAMES:
            continue
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()


def do_import(zip_path, include_backup=True, replace=False, force=False):
    zip_path = Path(zip_path)
    if not zip_path.exists():
        raise SystemExit(f"  ✗ no such file: {zip_path}")
    with zipfile.ZipFile(zip_path) as zf:
        manifest = _read_manifest(zf)
        if (manifest is None or manifest.get("tool") != "reading-room") and not force:
            raise SystemExit("  ✗ not a Reading Room backup (no valid manifest.json). "
                             "Re-run with --force to import anyway.")
        targets = list(_safe_targets(zf))
        if not targets:
            raise SystemExit("  ✗ nothing importable in this zip.")
        if include_backup:
            snap, _ = do_export(BACKUPS / f"pre-import-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}.zip")
            print(f"  ✓ safety snapshot of current data → {snap.relative_to(ROOT)}")
        if replace:
            for top in sorted({t.split('/', 1)[0] for _, t in targets}):
                _wipe_contents(ROOT / top)
        written = 0
        for info, norm in targets:
            dest = ROOT / norm
            dest.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
            written += 1
    return written, manifest


def main():
    ap = argparse.ArgumentParser(description="Back up / restore all Reading Room user data as a zip.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("export", help="write a backup zip of all user data")
    pe.add_argument("-o", "--out", help="output zip path (default backups/reading-room-backup-<timestamp>.zip)")
    pe.add_argument("--no-pdfs", action="store_true", help="exclude downloaded PDFs (much smaller)")

    pi = sub.add_parser("import", help="restore user data from a backup zip")
    pi.add_argument("zip", help="path to a backup zip")
    pi.add_argument("--replace", action="store_true",
                    help="wipe the data dirs the zip covers first (exact restore) instead of merging")
    pi.add_argument("--no-backup", action="store_true", help="skip the safety snapshot of current data")
    pi.add_argument("--force", action="store_true", help="import even without a valid manifest")

    pl = sub.add_parser("list", help="show a backup's manifest without extracting")
    pl.add_argument("zip", help="path to a backup zip")

    args = ap.parse_args()

    if args.cmd == "export":
        out, man = do_export(args.out, include_pdfs=not args.no_pdfs)
        c = man["counts"]
        print(f"  ✓ backup written → {out}")
        print(f"    {c['reports']} report(s), {c['comparisons']} comparison(s), {c['discussions']} discussion(s)"
              + (f", {c['pdfs']} PDF(s)" if man["includes_pdfs"] else ", PDFs excluded"))
        return 0

    if args.cmd == "import":
        n, man = do_import(args.zip, include_backup=not args.no_backup, replace=args.replace, force=args.force)
        print(f"  ✓ restored {n} file(s) from {args.zip}" + (" (replace)" if args.replace else " (merged)"))
        print("    now run  python scripts/build.py  to regenerate the site.")
        return 0

    if args.cmd == "list":
        with zipfile.ZipFile(args.zip) as zf:
            man = _read_manifest(zf)
        print(json.dumps(man, indent=2) if man else "  ! no manifest.json in this zip")
        return 0


if __name__ == "__main__":
    sys.exit(main())
