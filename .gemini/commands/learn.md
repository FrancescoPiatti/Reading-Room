---
description: Discuss an already-catalogued paper interactively, then on End chat / "done" compact the conversation into a standalone Discussion stored like a comparison (listed below the reading list).
argument-hint: <id-or-arxiv> [opening question or topic] [--approve]
---

You are having an **interactive discussion** about one paper already in the Reading Room, and then — only when the reader signals **done** (the app's **End chat** button sends this, or they type "done"/"that's it"/"wrap up") — **compacting** that conversation into a standalone record stored as `chats/<slug>/chat.json` and rendered **like a comparison**: its own page plus a **"Discussions"** entry **below the reading list**. It is a **chat record, not a worked derivation** (for proofs / full derivations / mechanism traces use `/deep-dive`). It must **never become a paper or catalogue card**, and must **never modify any digest**. Work **interactively**; do **not** use any external API or CLI commands directly.

## Input
`$ARGUMENTS` = a paper id (arXiv id or report slug), optionally an opening question/topic, and `--approve`.

1. Normalize the id (lowercase, drop `arXiv:` prefix and any `vN` suffix).
2. Confirm `reports/<id>/digest.json` exists. If not, stop and tell the reader to run `/explain-paper <id>` first — `/learn` discusses an *already-catalogued* paper, it does not create one.
3. Re-read the paper from `papers/<id>.pdf` (re-download if missing: `curl -L -o papers/<id>.pdf https://arxiv.org/pdf/<id>.pdf`). If the Read tool can't render it, fall back to a text extraction in `.cache/<id>.txt` (gitignored) — never leave `.txt` in `papers/`. Skim the existing digest (its sections, any deep dives) so you build on it rather than repeat it.

## The conversation
Have a **real back-and-forth** grounded in the paper: answer the reader's questions, pressure-test assumptions, surface connections, and work through *their* framing. Pitch it to the reader's profile (assume fluency in their expertise) and `config.tone`. Ground every claim in the paper — cite section/figure/equation numbers; if you go beyond the paper, say so; never invent results. **Keep the discussion going and write NOTHING** until the reader signals **done** (the **End chat** button, or "done"/"that's it"/"wrap up").

**Reader's profile.** Before the first reply read `user/profile.json` (expertise, defaults) and, when it exists, `user/profile.md` — the reader's free-form full profile (background, current projects, what they want from reports, style preferences), seeded by `/setup` and edited by the reader. The Markdown tells you what they're working on and what they care about, so the discussion connects to *their* problems instead of staying generic; it complements `profile.json` and never overrides the question they actually asked. If it's absent, carry on without it (don't create it here).

## On "done" — compact, then write (with approval)
1. **Compact** the conversation into a self-contained record — not a transcript, a distilled note a future reader would value: the **questions we resolved**, the **key insights**, and the **reader's framing / positions** (keep a short "still open" note if useful).
2. Derive a **`slug`**: short, from the topic / your title (lowercase, non-alphanumerics → `-`, e.g. `s4-as-a-linear-cde`). If `chats/<slug>/` already exists, suffix `-2`, `-3`, …. Don't reuse a paper id as the slug.
3. Show the compacted summary **and the slug** and **wait for approval** before writing — **unless `--approve` was passed**, in which case post it for the record and write straight away.
4. Write **`chats/<slug>/chat.json`**. Do **not** touch any `digest.json`, the catalogue, or other chats:

```json
{
  "id": "<slug>",
  "title": "Discussion: <topic>",
  "papers": ["<id>"],
  "added": "<today's date, YYYY-MM-DD>",
  "tldr": "One line on what we settled.",
  "html": "..."
}
```

- `papers` lists the paper(s) the chat is about (one for `/learn`; the build links them and shows **"Discussed in"** on each report). It is **not** a digest and **not** a catalogue card — it surfaces only under **Discussions** below the reading list and on its own `chat/<slug>/` page.
- **HTML rules** are the same as a digest section: only `<p> <h3> <ul> <ol> <li> <strong> <code> <pre> <a> <table> <thead> <tbody> <tr> <th> <td>`; LaTeX with `\\( … \\)` / `\\[ … \\]` (escape backslashes in JSON); `<div class="callout"><span class="k">Key point</span> … </div>` for a pivotal takeaway. Use `<h3>` for internal structure — the `title` is rendered as the page `<h2>`, so don't add your own top-level `<h2>`.
- Be grounded: cite the paper's section/figure/equation numbers; mark anything that went beyond the paper as such. Never invent results.

## Then build and report back
Run `python scripts/verify.py --build`, fix any `✗` failures, confirm the new chat appears under **Discussions** on `docs/index.html` (and as **"Discussed in"** on the paper's report), and tell the reader to refresh. Mention anything left open.
