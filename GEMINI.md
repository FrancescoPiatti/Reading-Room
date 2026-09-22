# Reading Room — Gemini CLI context

Reading Room is a personal catalogue of focused paper breakdowns. **You** — Gemini CLI, run interactively by the reader under their own subscription; never an external assistant API or a non-interactive assistant CLI — write every report. `scripts/build.py` renders them into a static site the reader opens in the app or hosts on GitHub Pages.

## What the reader asks you to do

The app sends these into this terminal (usually with `--approve`); the reader may also type them. Each one is fully specified in `.gemini/commands/<name>.md (declared by `<name>.toml`)` — read that file when the command is invoked.

| Command | Does |
|---|---|
| `/explain-paper <arxiv-id \| url \| path.pdf> [--views …] [--depth …] [--audience …] [--focus "…"] [--approve]` | reads a paper and writes `reports/<id>/digest.json` (a local PDF path is how a paper that isn't on arXiv gets in) |
| `/compare <id> <id> [<id>] [--focus "…"] [--approve]` | a side-by-side comparison → `compares/<slug>/compare.json`; `--focus` organises it around that question (stored as plain text) |
| `/learn <id> [topic] [--approve]` | an interactive discussion of a catalogued paper; on **End chat** / "done" compacts it → `chats/<slug>/chat.json` (listed below the reading list — never a digest, never touches one) |
| `/deep-dive <id> <topic> [--into <section> \| --append] [--approve]` | a worked derivation / proof / mechanism trace → the digest's `deepdives` array (a "Deep dive" tab) or merged into a named section |
| `/remove <id> [--approve]` | deletes a paper — digest, notes, PDF, generated page — and rebuilds; reports comparisons that referenced it |
| `/refresh-venues` | finds published versions of papers still marked as arXiv preprints (DBLP) and updates `venue` + `bibtex` |
| `/setup` | profile + field config, from the app's questionnaire (`user/.setup-intake.json`, deleted when done — that is how the app knows) or a conversation; `--review-profile` reconciles the config with `user/profile.md` |
| `/backup export\|import` | all user data as one zip (`scripts/archive.py`) |
| `/update` | brings this copy up to date through its own git remote; never touches the reader's data |

- **Gate**: `explain-paper`, `compare`, `learn`, `deep-dive` pause at their Gate (outline / dimensions) for approval — **unless `--approve` is passed**: post the outline for the record, then write. `remove` confirms the delete instead (also skipped by `--approve`). `refresh-venues` never gates.
- Read PDFs directly with your file reader (it renders pages). Don't leave `.txt` files next to the PDFs in `papers/` — extracted text goes in `.cache/` (gitignored).
- After writing anything, run **`python3 scripts/verify.py --build`** (`python` on Windows): it builds and runs QA — digest schema, HTML tag balance, LaTeX delimiters, citations, tags, BibTeX, contrast. Fix every `✗`; `!` is advisory. **Never hand-edit `docs/`** — it is generated from `reports/` and friends.
- Under the app, the local server watches `reports/`, `compares/` and `chats/` and rebuilds by itself the moment your file lands; the reader is told when the page is ready.

## Where things live

```
reports/<id>/digest.json        one per paper — the source of truth (you write these)
reports/<id>/notes.md           the reader's own notes — rendered, never overwritten
compares/<slug>/compare.json    comparisons          chats/<slug>/chat.json   discussions
papers/<id>.pdf                 downloaded PDFs (gitignored)     .cache/    extracted text (gitignored)
user/                           the reader's config — gitignored, so updates never touch it:
  profile.json                    who they are + report defaults (expertise, depth, audience)
  profile.md                      free-form full profile (background, projects, what they want) — read it when present
  config.json                     field config: fields (packs), tags, sections, site_title
  dismissed.json                  reading-queue dismissals     reading-state.json   status / stars / collections
templates/fields/<field>.json   discipline packs: tag vocabulary, focus-view titles, lens, tone
templates/                      page templates, base.css, account.html (avatar menu, Setup, Tutorial)
scripts/build.py                the static-site generator (stdlib)     scripts/verify.py   build + QA
scripts/archive.py              back up / restore                      docs/               the generated site
workmode/                       the app's local server (Node): terminal, live rebuilds, backup, update
.gemini/commands/<name>.toml+.md the workflows above           .gemini/skills/     verify-build, run-reading-room
```

Two example digests ship with the template: `reports/1706.03762/` (*Attention Is All You Need* — the reference for digest JSON / HTML / LaTeX conventions) and `reports/hornik1989/` (a local-PDF paper with no arXiv id). The reader removes them with `/remove`.

## Writing a digest — the conventions that matter

- **Grounded.** Cite section / figure / equation numbers; never invent metrics; say so when you go beyond the paper. Pitch it to `user/profile.json` (and `profile.md` when it exists) and the field's `tone`.
- **Section keys are fixed** — `summary`, `math`, `architecture`, `results`, `significance`, `reproducibility`. **Never rename a key**: every existing digest uses them as storage keys; the field pack only changes the *titles*. `summary` + `significance` are required (`significance` merges novelty, critique and why it matters for the field). `reproducibility` is opt-in — only when asked (`--views` / `--focus`) or when it is in the reader's default views. A one-off section (e.g. from `--focus`) renders without being declared anywhere.
- **Tags**: 2–4 per paper, from the **active vocabulary** — `user/config.json` `tags` if set, else the union of the reader's field packs (in `fields` order), else the shipped ML default. `verify.py` fails on a tag outside it. Never invent one; add it to the config deliberately.
- **HTML you author**: only `<p> <h3> <ul> <ol> <li> <strong> <code> <pre> <a> <table> <thead> <tbody> <tr> <th> <td>`, plus `<div class="callout"><span class="k">Key point</span> … </div>`; LaTeX as `\\( … \\)` / `\\[ … \\]` (backslashes escaped inside JSON). The build strips anything else. No `<h2>` — the title is the page's `<h2>`.
- **Citations**: `cites: [{id, title}]` with normalised arXiv ids — the graph links papers with them and builds the reading queue (a reference cited by two analysed papers becomes a ghost node). Keep `source_url` on arXiv, but set `published` (`{type: "article"|"inproceedings", venue, year, volume?, number?, pages?, publisher?}`) or a raw `bibtex` override when the paper has a venue, so the exported BibTeX is the journal / venue entry.
- **Reading state**: seed `status: "to-read"` and `priority: 0`; the reader changes them in the UI and their choice wins.
- **Deep dives** live in the digest's `deepdives` array (`{title, added, html}`) or, with `--into`, merged into a section — never written by `explain-paper`. **Discussions** (`chats/`) are chat records stored like a comparison — never a digest or catalogue card.
- **Discipline is config, not code.** `config.fields` merges the shipped packs (the primary field first — order decides tag order and section titles); explicit `tags` / `sections` in the config win over the packs. Don't hardcode machine learning anywhere.

## The app, in one paragraph

The reader normally uses **the app** (`ReadingRoom.app` / `ReadingRoom.bat` / `ReadingRoom.sh` → a loopback-only local server with an integrated terminal running you). Its flow buttons launch you and send the command; **Discuss** keeps the terminal visible, everything else runs hidden and is completed when your file lands. No API key is ever involved — that is the point. In prose say "Reading Room" or "the app" (`workmode/` is only the directory name). The static `docs/` site keeps working without it.

## Changing the site or the app

Usually unnecessary: a discipline, a vocabulary, a focus view or the site title are all config (`user/config.json`, the packs). If you do touch code — colours are CSS tokens in `templates/base.css` (`:root` is light, `[data-theme="dark"]` overrides; never hard-code one); `docs/` is regenerated by the build; the app's terminal, job and update logic is documented in `workmode/server.js` and `workmode/client/workmode.js` themselves. Run the QA build afterwards.
