---
description: Bring this Reading Room clone up to date with the latest version — fetch, show what's new, pull safely, run any migration, rebuild — without touching the reader's library.
---

You are updating the **app itself** — the code, templates, scripts, launchers, and commands of this Reading Room clone — to the latest version — from its git remote, or (for a ZIP download) from the published release archive. The reader's data is **never** part of an update: `reports/`, `compares/`, `chats/`, `user/`, and `papers/` are theirs and must survive exactly as they are; `docs/` is generated and can always be rebuilt. Work **interactively**; do **not** use the Anthropic API or `claude -p`. Updates go through the clone's **own git remote and credentials** — never a GitHub/API token, never a zip downloaded over HTTP, never a reinstall.

The app's **avatar menu → Updates** normally applies an update by itself (fast-forward pull + rebuild). You run when that automatic path couldn't finish — a pull that isn't a fast-forward, a failed `npm install`, an `UPGRADING.md` that needs a migration — or when the reader types `/update` in the terminal. Either way the goal is the same: finish the update cleanly, with the library intact, and tell the reader to restart the app.

## 0. A ZIP download (no `.git`)?
If the repo root has no `.git` folder, this copy was downloaded as a ZIP and there is nothing to pull. Update it the way the app does: check the published version (`https://raw.githubusercontent.com/FrancescoPiatti/Reading-Room/main/VERSION`) against the local `VERSION`; if newer, download `https://github.com/FrancescoPiatti/Reading-Room/archive/refs/heads/main.zip` into `backups/` and run `python scripts/update_zip.py backups/<that>.zip` — it overlays every app file in place and **never writes** `reports/`, `compares/`, `chats/`, `user/`, `papers/`, `backups/` or `workmode/node_modules/` (it prints what changed and whether `workmode/` — a restart — or `workmode/package*.json` — an `npm install` — changed). Then continue at §4. Skip §1–§3.

## 1. Check the clone and fetch
- Confirm this is a git checkout with an `origin` remote (`git rev-parse --is-inside-work-tree`, `git remote get-url origin`). If not, stop and explain that this copy wasn't installed with git so it can't self-update: the safe route is `/backup export`, a fresh clone, then `/backup import`.
- Determine the branch: `git rev-parse --abbrev-ref HEAD`; if detached (`HEAD`), use `main`. Call it `<branch>`; the remote ref is `origin/<branch>`.
- Run `git fetch --quiet origin` with `GIT_TERMINAL_PROMPT=0` in the environment so a credential prompt fails fast instead of hanging. If the fetch fails (no network, expired credentials, private repo without access), report the error and stop — nothing has changed yet.

## 2. Show what's new
- `behind` = `git rev-list --count HEAD..origin/<branch>`; `ahead` = the reverse (`origin/<branch>..HEAD`).
- If `behind` is 0: say **"You're up to date (<VERSION>)"** (the `VERSION` file at the repo root) and stop.
- Otherwise post: local version (`VERSION`) → remote version (`git show origin/<branch>:VERSION`), and the change list from `git log --format='%h %s' HEAD..origin/<branch>` (newest first). If `CHANGELOG.md` is among the changed files, its new top section(s) are the readable summary — quote them briefly. Check `git diff --name-only HEAD..origin/<branch>` for `UPGRADING.md`: if it changed, this update carries a migration that needs your help after the pull (step 4).
- If `ahead > 0` (the reader has local commits) or `git status --porcelain` shows **modified tracked files outside `docs/`**, say so before pulling — local edits to code or templates may conflict. Uncommitted changes under `reports/`, `compares/`, `chats/`, `user/`, `papers/` are the reader's data: they are never in the way (most are gitignored) and must not be stashed, reset, or discarded.

## 3. Pull — fast-forward first, then careful conflict handling
1. `docs/` is generated: if `git status --porcelain -- docs` lists tracked modifications, discard them with `git checkout -- docs` (it is rebuilt in step 5). Untracked files under `docs/` can stay.
2. `git pull --ff-only origin <branch>`. If it succeeds, go to step 4.
3. If it is **not** a fast-forward (local commits, diverged history): `git pull --no-rebase origin <branch>` and resolve every conflict with one rule — **the reader's data wins, upstream wins for code**:
   - anything under `reports/`, `compares/`, `chats/`, `user/`, `papers/`: keep the local version (`git checkout --ours -- <path>`), never delete it;
   - code, templates, scripts, launchers, the command/skill files, `docs/`: take upstream (`git checkout --theirs -- <path>`);
   - list the conflicted files and how each was resolved, then `git add` them and commit the merge.
   Never `git reset --hard`, never `git clean`, never force-push — and don't push at all unless the reader asks.

## 4. Post-pull steps
- Record the old and new HEAD (`<old>` = the commit before the pull, `<new>` = `HEAD`). If `workmode/package.json` or `workmode/package-lock.json` changed between them (`git diff --name-only <old>..<new>`): run `npm install --no-audit --no-fund` in `workmode/`. If npm's script policy skipped `node-pty`'s native build, also run `npm rebuild node-pty` there — otherwise the app opens with a dead terminal.
- If `UPGRADING.md` exists, **read it** — it is written for you by the maintainer (e.g. rename a config key, re-run a script over every digest). **Carry out** every migration step that applies to this update: anything it added or changed in this pull, plus any earlier step whose described end state isn't in place yet (check before redoing — the automatic path may have skipped it, or a previous update ran without an assistant). Do the steps, don't just quote them. A migration touches the reader's data only in the way the file says; if a step looks like it would lose data, stop and ask first.
- New or changed field packs (`templates/fields/*.json`) and config keys are picked up by the build's merge — no action unless `UPGRADING.md` says otherwise.

## 5. Rebuild and verify
Run `python scripts/verify.py --build` and fix any `✗` failures. If the new version fails QA on the reader's **existing** digests, that is a regression in the update, not a fault in their data — report it (with the failing check) rather than editing a digest to make it pass. Confirm `docs/index.html` was regenerated.

## 6. Report back
Tell the reader: the version they moved from → to, the highlights, anything you had to resolve or migrate, and that **the app needs a restart to finish** — close the Reading Room window and open it again (`ReadingRoom.app` / `ReadingRoom.bat`; someone running `npm start` in a terminal just reruns it). Their library, notes, and settings are exactly as they were.
