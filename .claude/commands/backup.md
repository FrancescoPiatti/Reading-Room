---
description: Back up or restore all Reading Room user data (analysed papers, comparisons, discussions, config) as a single zip.
argument-hint: export | import <path-to.zip> [--no-pdfs] [--replace] [--approve]
---

Package the reader's data into a portable zip, or restore it from one. This is a thin,
safe wrapper around `scripts/archive.py` (pure stdlib) — **run the script, don't reimplement the
zipping.** Work interactively; confirm before an import (it changes files) unless
`--approve` is passed.

## Input
The user passed: `$ARGUMENTS` — expected to start with `export` or `import`.

## What's included
`scripts/archive.py` bundles everything the reader owns and nothing generated:
- `reports/` (digests + your `notes.md`), `compares/`, `chats/`, `user/` (profile/config/dismissals, the full profile `profile.md`, and `reading-state.json` when the app's Back up has written one), and `papers/*.pdf`.
- **Excluded:** the generated `docs/` site (rebuild with `python scripts/build.py`) and transient files (`.setup-intake.json`, `.DS_Store`, `__pycache__`).
- **Browser reading state** — status / priority **stars** and collections — lives in `localStorage`, not on disk, so a *terminal* export can't see it. The **Reading Room app's avatar menu → Back up → "Full backup (zip)"** runs this same script and additionally drops the browser state into the zip as `user/reading-state.json` (the same JSON as the "Browser reading state only" export); **restoring that zip from the app** ("Restore from zip") puts the files back *and* reloads the reading state into the browser. So from the terminal, suggest either doing the whole backup from the app, or exporting/importing the stars separately via the avatar menu → Back up (JSON).

## export
Run:
```
python scripts/archive.py export            # → backups/reading-room-backup-<timestamp>.zip (includes PDFs)
python scripts/archive.py export --no-pdfs  # smaller: omit downloaded PDFs
python scripts/archive.py export -o <path>  # choose the output file
```
Then report the exact zip path and the counts it printed (reports / comparisons / discussions / PDFs). `backups/` is gitignored.

## import
**Gate:** first confirm the target zip and that this will modify `reports/`/`compares/`/`chats/`/`user/`, **unless `--approve` was passed**. It's reasonably safe (a safety snapshot of current data is written to `backups/` first, and merge is the default — nothing is deleted), so once confirmed:
```
python scripts/archive.py import <path-to.zip>            # merge: add/overwrite files from the zip
python scripts/archive.py import <path-to.zip> --replace  # exact restore: wipe covered dirs first
```
The importer refuses a zip without a valid Reading Room `manifest.json` (pass `--force` only if you're sure), and it skips any unsafe entries (paths containing `..`, absolute paths, symlinks, or files outside the known data dirs). Peek first with `python scripts/archive.py list <path-to.zip>`.

After an import, run `python scripts/verify.py --build` (or `python scripts/build.py`) to regenerate the site, then tell the user to refresh `docs/index.html`. Report how many files were restored and where the safety snapshot was written. If the zip carried a `user/reading-state.json` (an export made from the app), note that a terminal import restores it **to disk only** — the reader loads it into the browser from the app's avatar menu → Back up (import that JSON), or simply restores the zip from the app next time, which does both at once.
