# Reading Room

A personal, no-API tool for explaining papers. Read a paper **once** in an interactive AI coding session (Claude Code, Codex, or Gemini); it writes a focused, multi-tab HTML report into a searchable catalogue you can open locally or host free on GitHub Pages.

**It adapts to you.** A short Setup picks your field(s) and seeds a tag vocabulary + the focus-view tabs each report is split into — both editable, in any discipline (ML/maths, bio, econ/finance, engineering, medicine, …). Each paper is then **divided into the topics that fit *that* paper**, anchored on your defaults and pitched to your profile. Summary and Significance are always written; the rest adapts.

Nothing runs headlessly or via a paid API — generation happens interactively in your normal AI coding session (Claude Code, Codex, or Gemini), covered by your existing subscription. The build is plain Python with **no dependencies**.

## What it looks like

| The catalogue | A report |
|---|---|
| ![The catalogue: paper cards with search, tag filters, and reading status](assets/shots/catalogue.png) | ![A report: focus-view tabs, real LaTeX, results tables](assets/shots/report.png) |

<!-- VIDEO PLACEHOLDER: ~60s overview — explain a paper, browse the catalogue -->
<!-- VIDEO PLACEHOLDER: adaptability — Setup picks fields, custom focus views, per-paper topic division -->
<!-- VIDEO PLACEHOLDER: work mode — discuss a paper (/learn) + End chat, and /deep-dive -->

## Setup
1. **An AI coding assistant — required.** [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), Codex, or Gemini, installed and logged in (its CLI must run from a terminal). Reports are authored in your AI session, covered by your existing subscription — no API key, no separate account.
2. **Python 3.8+** and **[Node.js](https://nodejs.org/) 18+** — both free. You never run them yourself; the app uses them under the hood and tells you if one is missing.
3. **Clone this repository** — paste one line and you're done. It lands in your home folder (a safe spot: not Desktop, not OneDrive — see the first-launch notes) and the folder opens by itself:
   - **macOS** (Terminal): `cd ~ && git clone https://github.com/FrancescoPiatti/Reading-Room.git ReadingRoom && open ReadingRoom`
   - **Windows** (PowerShell): `cd ~; git clone https://github.com/FrancescoPiatti/Reading-Room.git ReadingRoom; explorer ReadingRoom`

   (Forking first, or downloading the ZIP and unzipping to `~/ReadingRoom`, works too.)
4. **Double-click `ReadingRoom.app`** (macOS) or **`ReadingRoom.bat`** (Windows). The app opens with a short tutorial, hands off to **Setup** (your field, focus views, defaults), and offers to put a **Reading Room shortcut on your Desktop** (or a folder you pick). Its integrated terminal is where your AI runs.

Two example papers ship in the catalogue (*Attention Is All You Need* and Hornik's universal-approximation theorem) so the first launch isn't empty and you can see finished reports — keep them, or `/remove <id>` once you've added your own.

**Updating later:** your data never mixes with the app's code — digests live in `reports/`, your settings in `user/` (gitignored) — so `git pull` (or re-downloading) updates the tool without touching your library. `/backup export` zips all of it anytime.

## Use it
In the app, click **Explain a paper** (the command picker pre-types it into the terminal), or start your AI in the Terminal drawer and type:

```
/explain-paper 2402.01234              # arXiv id
/explain-paper https://arxiv.org/abs/2402.01234
/explain-paper ~/Downloads/paper.pdf   # local file
```

It downloads/reads the PDF, shows you a short outline + proposed tags and focus views, and **waits for your approval**. After you say go, it writes the report, the site rebuilds itself, and the new card appears in the catalogue.

**Adding a paper that isn't on arXiv:** `/explain-paper` accepts an arXiv id/URL, a **direct PDF URL**, or a **local PDF path** (e.g. `/explain-paper ~/Downloads/paper.pdf`) — so anything you have a PDF for can go in the catalogue.

## More commands
- `/compare <id> <id> [<id>]` — a side-by-side comparison page of papers already in the library.
- `/learn <id> [topic]` — **discuss** a catalogued paper interactively; on **End chat** it compacts the conversation into a Discussion, listed below the reading list (stored like a comparison — never a new paper).
- `/deep-dive <id> <topic>` — a worked derivation / proof / mechanism trace, as its own "Deep dive" tab or merged into a section you name.
- `/remove <id>` — delete a paper (digest, notes, PDF, generated page) and rebuild; confirms first.
- `/refresh-venues` — update preprints to their published venue + BibTeX (DBLP).
- `/setup` — (re)configure your profile + field(s) (see "Make it yours").
- Add `--approve` to skip a command's confirmation gate.

## Browse
`docs/index.html` is the catalogue: client-side search and tag filters, data embedded so it works by double-clicking — no server needed. Each report is a self-contained page with the focus views as tabs and live MathJax equations. Fonts and the search/graph libraries are **self-hosted** inside `docs/assets/` (nothing pings Google or a CDN about what you read, and everything but equation rendering works fully offline; without a connection LaTeX just shows as readable source).

## Host it (optional)
Push the repo to GitHub, then Settings → Pages → deploy from branch, folder `/docs`. The catalogue is live at your Pages URL. Downloaded PDFs are gitignored; `docs/` is deliberately **committed** — it's what Pages serves.

## The app (work mode)
The app is the **default way to use Reading Room**: one window with the catalogue, an **integrated AI terminal** (Claude, Codex, or Gemini) in a bottom drawer, and **live rebuilds** — analyze a paper in the terminal and the catalogue/graph refresh themselves. It's a small local server (`workmode/`) bound to loopback only, never exposed to the network. The static site underneath (`docs/`, openable directly or hosted on GitHub Pages) keeps working without it — see "Browse" below.

**Launch it:** double-click **`ReadingRoom.app`** (macOS) or **`ReadingRoom.bat`** (Windows). First run installs deps and **offers to put a "Reading Room" shortcut on your Desktop** (or a folder you pick — you can skip it; to get the offer again later, delete `user/.desktop-shortcut-offered` and relaunch); each launch then starts the server **in the background** and opens a chromeless app window. With `ReadingRoom.app` **no Terminal window appears at all** (errors, if any, show as a dialog). *(Prefer a terminal? `cd workmode && npm start` runs the same server in the foreground with visible logs.)*

> **macOS first-launch notes.** The app is unsigned, so Gatekeeper may block the first open — right-click the app → **Open** (or run `xattr -d com.apple.quarantine ReadingRoom.app`). **Where the folder lives matters:**
> - Best: a plain local folder like `~/ReadingRoom` or `~/GitHub/reading-room`.
> - Desktop / Documents / Downloads / OneDrive / iCloud are **privacy-protected (TCC)**: macOS gates each app's file access there. If double-click does nothing or you see a *"macOS is blocking…"* dialog, grant access once in **System Settings → Privacy & Security** (Files & Folders, or Full Disk Access → **+** → add `ReadingRoom.app`) and open it again. Updating the app can reset this — same 10-second fix.
> - Cloud-synced folders (OneDrive/iCloud/Dropbox) also **evict file contents to the cloud** ("free up space"); the server then hangs or dies at startup on the placeholder files. If you must keep it there, right-click the folder → **Always Keep on This Device** — but a plain local folder avoids all of this.

In the app, everything is **one click** — no terminal to look at. **Analyze paper** takes an arXiv id, URL, or PDF path and writes the report for you; the ▾ next to it switches to **Compare** (pick 2–3 papers), **Deep dive** (worked derivation into an existing report), or **Discuss** (a live conversation — the one flow that opens the terminal, since you talk to it; **End chat** saves it as a Discussion). Each flow launches your chosen assistant (`claude`, `codex`, or `gemini`) in a hidden session, runs the command, and tells you when the result is ready — a **Show terminal** button reveals the live session if the assistant asks you something, and the app warns you if it goes quiet mid-run. Hollow **ghost nodes** on the Connections graph become actionable (**Analyze** / **Dismiss** / **Keep**); report pages get **View PDF** and **Edit notes** buttons; a discussion page gets **Remove discussion**. The terminal drawer never opens itself — it's there behind the **Terminal** button whenever you want to type commands yourself.

The app window is chromeless, so external links (e.g. arXiv) open in your normal browser instead of stranding the window. The server runs **headless in the background** (no Terminal window). **Closing the app window stops it** a few seconds later (so a refresh doesn't kill it); its output goes to `workmode/workmode.log`, and you can force-stop it with `kill $(cat workmode/workmode.pid)` (macOS) or via Activity Monitor / Task Manager. Set `RR_KEEPALIVE=1` to keep it running after the window closes, or `RR_PORT=5000` to change the port. The reading queue and ghost nodes offer **Analyze / Dismiss / Keep**, and report pages get a **View PDF** button — *View PDF* opens the analyzed paper **inside the app** (the local `papers/<id>.pdf`, or proxied from arXiv through the local server) with a **Back** button, so you never leave the window. Ghost papers aren't downloaded, so they have no *View PDF*.

**Works on macOS and Windows.** `ReadingRoom.app` (macOS) and `ReadingRoom.bat` (Windows) are equivalent; the server, UI, live rebuild, and ghost/queue actions are all cross-platform. On macOS the launcher carries a custom icon — if cloud sync ever strips it, `bash assets/build-icon.sh` reinstalls it.

**A note on the terminal component:** the integrated terminal uses `node-pty`, which installs a prebuilt binary when one exists for your Node version, otherwise compiles it — that needs a C/C++ toolchain (macOS: `xcode-select --install`; Windows: "Desktop development with C++" Build Tools). If it can't build, everything except the terminal still works.

## Make it yours
- **Profile & setup**: the **avatar** in the header opens **Profile** and **Setup** — a short questionnaire for your name, field(s), default focus views (**add your own**), tag vocabulary, and depth/audience. In work mode, finishing auto-runs `/setup`, which writes `user/profile.json` + `user/config.json`; the commands read those at runtime, so reports adapt **without editing any command files**. Config lives under `user/` (gitignored), so app updates never overwrite it.
- **Fields & focus views**: choose discipline packs or edit your own in Setup (or `user/config.json`) — tag vocabulary, focus-view tabs, lens, and tone. The shipped default is a general, math-derived vocabulary; make it yours. Each report still adapts its sections to the paper at hand.
- **Rename the site**: set `"site_title": "My Reading Room"` in `user/config.json` — the header, page titles, and footer all follow. (The repository may be published under a different name; the app inside is whatever you call it.)
- **Restyle**: everything visual lives in `templates/base.css`; rebuild to apply.
- **Reading status & priority**: each report and the Library page let you set status (to-read / reading / read) and a 0–3 star priority; choices persist in your browser (`localStorage`).
- **Go deeper**: `/deep-dive <id> <topic>` adds a worked derivation as a "Deep dive" tab or merges it into a section; `/learn <id>` discusses a paper and saves the compacted chat as a Discussion below the reading list.

### Configuration reference — `user/config.json`
Setup writes this for you; every key is optional and hand-editable:

```jsonc
{
  "site_title": "Reading Room",              // header / page titles / footer
  "fields": ["ml"],                           // shipped packs to merge, from templates/fields/
  "tags": ["deep-learning", "theory"],        // explicit vocabulary — WINS over the packs
  "max_tags": 4,                              // per-paper tag cap (scripts/verify.py enforces)
  "sections": [                               // focus-view tabs, in display order
    {"key": "summary", "title": "Summary"}
  ],
  "required_sections": ["summary", "significance"],
  "lens": "over-invest in the math",          // what reports lean on hardest
  "lens_key": "math",                         // which section is the lens view
  "tone": "technical, direct"                 // report voice
}
```

How merging works: `fields` unions the named packs' tag vocabularies **in the order listed**, and takes each section from the **first** pack that declares its key — so `["bio", "ml"]` and `["ml", "bio"]` differ in tab order/titles. Anything you set explicitly here (e.g. `tags`) **wins over** the packs, which only fill in what you omit. Two rules: keep tags broad (2–4 per paper, the build enforces the vocabulary), and **never rename a section `key`** — keys like `math` are storage keys inside every existing digest (a pack/config only retitles them, e.g. "Methods & statistics"); renaming one blanks that tab on every report. Adding *new* keys is always fine.

## License
[MIT](LICENSE) © Francesco Piatti. Your own paper digests, notes, and PDFs are yours; the license covers the Reading Room tooling. The footer credit ("created by Francesco Piatti") is the tool's attribution and is hardcoded in `scripts/build.py` — forks are welcome under the MIT terms and may keep or amend it; `site_title` renames everything else without touching it.
