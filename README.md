# Reading Room

Your own reading room for papers. One click turns a paper into a focused, multi-tab
report — written by the AI coding assistant you already have (Claude Code, Codex CLI or
Gemini CLI) under your existing subscription, **no API key, no API billing** — and keeps it
in a fast, searchable catalogue on your machine. Compare papers, discuss one, go deeper on a
proof, follow the citation graph, export BibTeX. Everything stays local; the output is plain
HTML that is yours.

**See what it looks like and how to use it on the website:**
**https://francescopiatti.github.io/Reading-Room-Website/**

| ![Analyze a paper: enter it, the assistant reads it, the report builds](assets/shots/analyze.gif) | ![The app: catalogue, flows, and the terminal drawer](assets/shots/apptour.gif) |
|---|---|

## Install

1. **An AI coding assistant**, installed and logged in — [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), [Codex CLI](https://github.com/openai/codex) or [Gemini CLI](https://github.com/google-gemini/gemini-cli). It writes every report.
2. **Python 3** and **[Node.js](https://nodejs.org/) 18+** — free; the app uses them under the hood and tells you if one is missing.
3. **Get the folder.** Clone it into your home folder (a plain local folder, not Desktop or a cloud-synced one):
   - macOS: `cd ~ && git clone https://github.com/FrancescoPiatti/Reading-Room.git ReadingRoom && open ReadingRoom`
   - Windows (PowerShell): `cd ~; git clone https://github.com/FrancescoPiatti/Reading-Room.git ReadingRoom; explorer ReadingRoom`
   - Linux: `cd ~ && git clone https://github.com/FrancescoPiatti/Reading-Room.git ReadingRoom && cd ReadingRoom`

   Or download a [release](https://github.com/FrancescoPiatti/Reading-Room/releases) — a ZIP with the app's dependencies already built (macOS on Apple silicon today; clone on Windows and Linux).
4. **Double-click `ReadingRoom.app`** (macOS), **`ReadingRoom.bat`** (Windows) or **`ReadingRoom.sh`** (Linux). A short tutorial opens and hands you to Setup. Two example papers are already in the catalogue.

macOS may block the unsigned app the first time: **System Settings → Privacy & Security → Open Anyway** (or `xattr -dr com.apple.quarantine ReadingRoom.app`). Windows may show SmartScreen: **More info → Run anyway**. The [website's install page](https://francescopiatti.github.io/Reading-Room-Website/how-to-install.html) has the full walkthrough, including every prerequisite.

## Good to know

- **Updates** come from the avatar menu → **Updates**, for both a clone and a release download. A backup of your library is written before every update.
- **Your data** lives next to the app: `reports/` (the papers and your notes), `compares/`, `chats/`, `papers/` (PDFs), `user/` (profile, settings, reading state). An update never touches them; **Back up** (avatar menu) puts all of it in one zip.
- **Prefer a terminal?** Every flow is a slash command in your assistant — `/explain-paper <id | url | path.pdf>`, `/compare`, `/learn`, `/deep-dive`, `/remove`, `/refresh-venues`, `/setup`, `/backup`, `/update`. The app runs them for you; the terminal drawer is there if you want to type.
- **Host the catalogue** (optional): push to GitHub, enable Pages on `/docs`. The generated site is committed for that reason; `docs/` is never edited by hand — `python3 scripts/build.py` regenerates it from `reports/`.

## License

[MIT](LICENSE) © Francesco Piatti. Your paper digests, notes and PDFs are yours; the license covers the tooling.
