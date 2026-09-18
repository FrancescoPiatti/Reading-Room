# Changelog

All notable changes to Reading Room, newest first. `VERSION` at the repo root
names the current release; the app's update checker (avatar menu → **Updates**)
looks for new commits on your clone's git remote and installs them in one click.

## 1.2.0 — 2026-09-18

- **Updates for ZIP installs.** Copies downloaded as a ZIP (no `.git`) now check the
  published version on GitHub and update in one click too: the app downloads the
  latest archive and replaces its own files in place (`scripts/update_zip.py`) —
  your library, notes and settings are never written. The "Update available"
  dialog offers **Later** (until the next launch), **Skip this version** (never
  for that version; a newer one is still offered) and **Update now**.
- **Assistant settings.** Pick the model and reasoning effort each assistant
  launches with — a gear next to the claude / codex / gemini pills, or
  Terminal ▾ → Assistant settings. Used by every flow button and launch.
- **Save & review with assistant.** The full-profile editor can hand the
  Markdown to your assistant (`/setup --review-profile`), which brings
  `profile.json` and the field config in line with it.
- **Back up & restore** modal: the browser-state (JSON) export/import is now its
  own section like the other two; no footer buttons.
- Docs and website: field-neutral report description, itemized flows, install
  instructions and links for all three assistant CLIs, correct update story for
  both install methods.

## 1.1.0 — 2026-09-12

- **Full backup and restore from the app.** Avatar menu → **Back up** now
  exports everything — analysed papers, comparisons, discussions, notes,
  settings, your browser reading state and (optionally) the downloaded PDFs —
  as one zip in your Downloads folder (or the app's `backups/` folder, or a
  path you choose), with a **Show in folder** button. **Restore from zip**
  merges a backup into your library (or replaces it) and reloads. The
  "browser reading state only" JSON export stays as a secondary option and is
  still the only one on the static site.
- **Stop a running flow.** The Analyze / Compare / Deep dive overlay has a
  **Stop** button (with a confirm step). Stopping discards the run — nothing
  half-written is added to your library. A discussion can be stopped from the
  terminal drawer the same way. If you end the assistant from the terminal
  instead, the app notices and says so rather than spinning forever.
- **A full profile in Markdown.** Setup seeds `user/profile.md` (background,
  what you're working on, what you want from reports); the Profile view shows
  an excerpt and **Edit full profile** opens an in-app editor. Reports,
  comparisons, discussions and deep dives read it to calibrate to you.
- **Compare: search and a question.** The Compare form has a search box over
  your library and an optional "Question or topic" field; when you give one,
  the comparison is organised around answering it (`/compare … --focus "…"`).
- **Update checker and one-click update.** The app checks for a newer version
  on start and every few hours (and on demand from avatar menu → **Updates**),
  shows what changed, and installs it — pull, dependencies, rebuild — and offers
  a one-click restart when the app's own files changed. Your library, notes and settings are never touched by an
  update. If an update needs a hand, **Let the assistant do it** runs the new
  `/update` command.
- **Applications-folder shortcut.** The first-launch shortcut offer now
  includes the Applications folder on macOS and the Start Menu on Windows,
  alongside the Desktop.
- **Retina screenshots.** Tutorial and README figures are captured at
  1200×800 at 2× (a 2400×1600 image), so they stay crisp on high-DPI screens.
- **Reading queue threshold.** The Connections page now suggests a paper for
  your reading queue once two of your papers cite it.
- **App-first documentation.** README, tutorial and command help lead with the
  app (double-click `ReadingRoom.app` / `ReadingRoom.bat`); the terminal-only
  path is mentioned as an alternative. As before, there is no API key and no
  API billing — reports are written by your own AI coding assistant (Claude
  Code, Codex CLI or Gemini CLI) under your existing subscription.

## 1.0.0

- First release: the catalogue, report, Library and Connections pages;
  `/explain-paper`, `/compare`, `/learn`, `/deep-dive`, `/remove`,
  `/refresh-venues`, `/setup` and `/backup`; and the Reading Room app for
  macOS and Windows with its integrated AI terminal, Analyze / Compare /
  Deep dive / Discuss flows, live rebuilds and first-run tutorial.
