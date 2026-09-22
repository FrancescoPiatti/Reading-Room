# Changelog

All notable changes to Reading Room, newest first. `VERSION` at the repo root
names the current release; the app's update checker (avatar menu → **Updates**)
looks for a newer version — new commits on a clone's git remote, or a newer
published release for a ZIP copy — and installs it in one click.

## 1.3.2 — 2026-09-22

- **The model you pick has to exist for your account.** Assistant settings now lists the models each CLI on this machine actually offers — Codex's own list for your login (with the reasoning levels each model takes), Claude Code's aliases and effort levels, each CLI's configured default — instead of a list baked into the app. A Codex model or effort that isn't on its list is flagged in the settings and refused before a run starts, with the reason and the models to choose from. Before, a typo'd or unavailable model (`gpt-6`) booted fine and failed only once the command was in: `The 'gpt-6' model is not supported when using Codex with a ChatGPT account`, and the run spun.
- **An assistant that answers with an error is reported at once.** A run or discussion whose assistant replies with an error instead of working — a model it can't use, an expired login, a usage or rate limit — shows the assistant's own message on the card within a second. A fatal one (model / login) stops the run, rolls back and offers **Assistant settings**; a transient one (rate limit) stays advisory and clears once the assistant carries on.
- **`CLAUDE.md`, `AGENTS.md`, `GEMINI.md` are now written for the reader's assistant** — the commands, where data lives and the conventions for writing a digest, in ~65 lines — instead of the app's full design notes (Claude Code warned the file was over its size limit).
- Docs: the install pages say which release ZIP exists today; the Gatekeeper command strips quarantine recursively.

## 1.3.1 — 2026-09-21

- **The assistant's first launch works.** The app now judges an assistant by what it
  *shows*, not by how many bytes it printed: Claude's, Codex's and Gemini's trust dialogs
  (and their login screens) are recognised, the terminal comes up **on top of** the
  Analyze card or the Setup window so you can answer right there, and the command is
  sent only once the assistant's own prompt is on screen. Before, the "answer in the
  terminal below" card hid the terminal behind itself, *Show terminal* lost the
  Continue button, and the command could be typed straight into the trust dialog — which
  made Claude quit (its default is "No, exit") and left Codex and Gemini idle.
  *Continue* is offered only when the app cannot tell what the assistant is showing.
- **Setup keeps its window.** Launching an assistant from the last step no longer closes
  Setup for a small bar at the top: the terminal opens over it, a status line says what the
  assistant is asking, and **Apply setup** runs from the same window — refusing, with the
  reason, while a trust or login prompt is still up. Closing Setup part-way and reopening
  it resumes where you were; Esc in a field only leaves the field.
- **Tutorial**: every screenshot is shown whole in a fixed 3:2 frame (the Setup step was
  cropped to its top half), the card keeps one height so *Next* stays under the pointer,
  images are preloaded, and steps slide instead of re-laying out.
- Starting a flow while a **Discussion** is running now shows the discussion and offers End
  chat / Stop instead of killing it silently; *End chat* appears once the discussion has
  actually started. Esc typed in the terminal belongs to the assistant (it no longer closes
  the drawer, a panel or Setup). A missing CLI fails the run with that reason at once.
- A run whose page failed to **build** is reported as such (the file is kept) instead of
  "Added to your library"; a run whose assistant quit while no window was open is ended
  and rolled back by the server after 30 s, and a page that opens later is told so.
- Assistant choice, model/effort settings and the sort order now travel with the install
  (they survive a port change and a new browser), like the reading state.
- READMEs: the app's is short and points at the website; the website's summarises the app.

## 1.3.0 — 2026-09-19

- **Analyze a PDF from your computer.** *Choose PDF…* in the Analyze panel, or drop
  one (or several) anywhere on it: the file is copied into `papers/` and analyzed
  like any other paper. Most fields are not on arXiv, and the app window has no file
  browser of its own — this is how a paywalled or scanned paper gets in.
- **A queue, not one paper at a time.** *Add another* stacks papers up; the button
  then reads *Analyze N papers* and works through them in order, saying which one it
  is on, and finishes with a list of everything it added.
- **Per-run options** on Analyze: depth, audience and a focus for this run only,
  without typing flags. Your profile's defaults still apply when they are left alone.
- **Reading state is saved to disk** (`user/reading-state.json`) as well as in the
  browser. Status, stars, collections and dismissed graph nodes now survive a new
  browser, a different port (the app falls back when 4317 is busy — the library used
  to come back unread), and a restore from backup.
- **A run outlives its window.** Closing the app while a report is being written no
  longer kills it: the server stays up until the run lands, writes the report, and
  then quits. The run card also shows elapsed time and the assistant's last line, so
  a long job looks supervised rather than hung.
- **Remove paper** on a report page — it lists exactly what will be deleted and
  warns about comparisons built on that paper, then rebuilds.
- **Diagnostics** (avatar menu): versions, which assistants were found on PATH, how
  this copy was installed, the library's size and the tail of the server log, with
  one-click **Copy**.
- **Backups before updates, and on a schedule.** Every update now writes a PDF-less
  snapshot of the library first; *Back up* gained a daily/weekly/monthly automatic
  backup (only the five newest are kept).
- **Updates follow published releases**, not the branch head: a download now updates
  to the newest **release** (preferring the packaged ZIP for its platform), so it can
  never land mid-work code, and a clone names the newest version tag.
- **Linux launcher** (`ReadingRoom.sh`, with a menu entry on first run) and
  `scripts/package_release.sh`, which builds a release ZIP with the app's
  dependencies already installed — no `npm install` or native build on first launch.
- **Sort** the catalogue and the Library (year, recently updated, title, priority,
  reading status); the Library filter now also searches ids, years and summaries.
- **Accessibility**: the full-screen panels are proper dialogs (focus moves in, Tab
  stays inside, Esc closes, focus returns), run status is announced, graph nodes are
  keyboard-reachable, and the terminal has an optional screen-reader mode.

## 1.2.2 — 2026-09-19

- **Setup with Codex or Gemini.** Setup's auto-run now uses the syntax of the
  assistant that was actually launched (`$setup` for Codex), only after the
  assistant's screen is really up, and its Launch buttons grey out CLIs that aren't
  installed; a missing CLI is reported instead of typing into a bare shell.
- The "first launch" of an assistant is remembered per folder, so a moved or
  re-cloned copy shows the terminal again for its trust prompt.
- The hidden update check can no longer pop a credential-manager window; Python 3
  is checked by the launchers and the app says plainly when it is missing.
- Docs: `python3` in every command; macOS 15 Gatekeeper ("Open Anyway") and
  Windows SmartScreen notes.

## 1.2.1 — 2026-09-19

- **Codex and Gemini flows actually run.** Codex rejects unknown `/commands`
  before the model sees them, so the app now invokes its shipped skills as
  `$explain-paper …` etc.; Gemini CLI only loads `.gemini/commands/*.toml`, which
  are now generated from the Markdown sources (`scripts/gen_gemini_commands.py`,
  checked by `verify.py`). Codex is launched with its startup update prompt off.
- **First launch of an assistant is visible.** The first time the app launches
  claude / codex / gemini on an install, the terminal is shown and the flow waits
  for **Continue**, so a "trust this folder?" or login dialog never swallows the
  command.
- **Reports can't run scripts.** Authored HTML (sections, deep dives, comparison
  cells, discussions — including restored backups) is sanitized at build time and
  `verify.py` fails on active content; the built pages share the app's origin.
- **View PDF** works for papers that aren't on arXiv (a local `papers/<id>.pdf`).
- ZIP updates are staged and atomic (VERSION written last, clean error messages,
  docs/ and mis-cased data folders never overwritten); orphan pages under `docs/`
  are pruned on every build; a restore no longer keeps the uploaded zip.
- Stop no longer claims "nothing was added" once a report has landed; a run
  adopted from another page doesn't cry wolf; restarting waits for a running
  assistant to be stopped and rolled back; a ZIP copy that is current reads "up
  to date"; a git clone's "Skip this version" no longer silences later commits;
  Setup's Finish only auto-runs into a live assistant; Windows opens links
  without going through cmd.exe; builds get a 5-minute timeout.
- **Launcher fix (macOS).** An in-app update applied within seconds of launching
  made the .app treat the server's "restart me" exit as a failed start; the
  relaunch loop now handles an early exit 75 too.

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
- **Save & review.** The full-profile editor can hand the
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
