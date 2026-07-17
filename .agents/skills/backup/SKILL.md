---
name: backup
description: "Back up or restore all Reading Room user data (analysed papers, comparisons, discussions, config) as a single zip. Invoke only when the user explicitly selects $backup or /backup."
---

# Backup

## Invocation

Invoke explicitly as `$backup export | import <path-to.zip> [--no-pdfs] [--replace] [--approve]` in Codex or `/backup export | import <path-to.zip> [--no-pdfs] [--replace] [--approve]` in Reading Room work mode. In the workflow below, `$ARGUMENTS` means all text supplied after the skill or command name; never treat it as a literal value.


Package the reader's data into a portable zip, or restore it from one. This is a thin,
safe wrapper around `archive.py` (pure stdlib) — **run the script, don't reimplement the
zipping.** Work interactively; confirm before an import (it changes files) unless
`--approve` is passed.

## Input
The user passed: `$ARGUMENTS` — expected to start with `export` or `import`.

## What's included
`archive.py` bundles everything the reader owns and nothing generated:
- `reports/` (digests + your `notes.md`), `compares/`, `chats/`, `user/` (profile/config/dismissals), and `papers/*.pdf`.
- **Excluded:** the generated `docs/` site (rebuild with `python build.py`) and transient files (`.setup-intake.json`, `.DS_Store`, `__pycache__`).
- **Not on disk, so not in the zip:** the reader's status / priority **stars** live in the browser (`localStorage`). Point them to the header **avatar menu → "Back up"** to export/import those separately.

## export
Run:
```
python archive.py export            # → backups/reading-room-backup-<timestamp>.zip (includes PDFs)
python archive.py export --no-pdfs  # smaller: omit downloaded PDFs
python archive.py export -o <path>  # choose the output file
```
Then report the exact zip path and the counts it printed (reports / comparisons / discussions / PDFs). `backups/` is gitignored.

## import
**Gate:** first confirm the target zip and that this will modify `reports/`/`compares/`/`chats/`/`user/`, **unless `--approve` was passed**. It's reasonably safe (a safety snapshot of current data is written to `backups/` first, and merge is the default — nothing is deleted), so once confirmed:
```
python archive.py import <path-to.zip>            # merge: add/overwrite files from the zip
python archive.py import <path-to.zip> --replace  # exact restore: wipe covered dirs first
```
The importer refuses a zip without a valid Reading Room `manifest.json` (pass `--force` only if you're sure), and it skips any unsafe entries (paths containing `..`, absolute paths, symlinks, or files outside the known data dirs). Peek first with `python archive.py list <path-to.zip>`.

After an import, run `python verify.py --build` (or `python build.py`) to regenerate the site, then tell the user to refresh `docs/index.html`. Report how many files were restored and where the safety snapshot was written.

