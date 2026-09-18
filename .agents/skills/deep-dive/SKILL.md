---
name: deep-dive
description: "Go deeper on a paper already in the Reading Room — author a worked derivation / proof walkthrough and append it as a \"Deep dive\" to the existing report. Invoke only when the user explicitly selects $deep-dive or /deep-dive."
---

# Deep Dive

## Invocation

Invoke explicitly as `$deep-dive <id-or-arxiv> <topic, free text> [--into <section-key> | --append] [--depth deep|standard] [--approve]` in Codex or `/deep-dive <id-or-arxiv> <topic, free text> [--into <section-key> | --append] [--depth deep|standard] [--approve]` in the Reading Room app. In the workflow below, `$ARGUMENTS` means all text supplied after the skill or command name; never treat it as a literal value.


You are adding an **incremental deep dive** (a full worked derivation, proof walkthrough, or mechanism breakdown) to an existing Reading Room report. This does NOT regenerate the digest — it either **appends** a self-contained entry to the paper's `deepdives` array (its own **Deep dive** tab) **or merges** into a digest section you name, then rebuilds. Work **interactively**; do **not** use an external assistant API or a non-interactive assistant CLI.

## Input
`$ARGUMENTS` = a paper id (arXiv id or report slug) followed by the **topic** to go deep on (free text), optionally a routing flag (`--into <section-key>` to merge, or `--append`), `--depth`, and `--approve` (skip the Gate's wait — post the outline for the record and write straight away).

1. Normalize the id (lowercase, drop `arXiv:` prefix and any `vN` suffix).
2. Confirm `reports/<id>/digest.json` exists. If not, stop and tell the user to run `/explain-paper <id>` first — `/deep-dive` deepens an *already-catalogued* paper, it does not create one.
3. Re-read the paper from `papers/<id>.pdf` (re-download if missing: `curl -L -o papers/<id>.pdf https://arxiv.org/pdf/<id>.pdf`). If the running assistant's PDF-capable file reader can't render it, fall back to a text extraction in `.cache/<id>.txt` (gitignored) — never leave `.txt` in `papers/`.
4. Read the existing digest's `math`/relevant sections so the deep dive *complements* (doesn't repeat) what's already there.

## Purpose — how a deep dive differs from the digest
The digest's lens view (key `math`; see the field config `user/config.json` for the field's framing/title and `config.lens`/`config.tone`) gives the core logic at reference depth. A deep dive goes a level lower on **one** thing the user names — the field's core artifact: every step of a proof or full derivation with the algebra shown (maths), a careful identification argument (econ), an assay/protocol and statistical-validity walkthrough (bio), a concrete worked example, or a mechanism trace. Pitch it to the reader's profile (assume fluency in their expertise) and `config.tone`. Default `--depth deep`.

**Reader's profile.** Read `user/profile.json` (expertise, defaults) and, when it exists, `user/profile.md` — the reader's free-form full profile (background, current projects, what they want from reports, style preferences), seeded by `/setup` and edited by the reader. Use it to decide how much to spell out and which steps deserve the most care (e.g. the parts closest to their own work); it complements `profile.json` and never overrides the flags or the topic they named. If it's absent, carry on without it (don't create it here).

## Gate — confirm before writing
Post and **wait for approval**:
- the paper and the exact topic you'll deep-dive;
- a short outline (the steps/claims you'll work through) and roughly how long;
- **where it goes** — a new **Deep dive** entry (append), or **merged into a named section**. If `--into <key>` or `--append` was passed, state the choice; otherwise **ask which**.

Only continue once the user says go — **unless `--approve` was passed**, in which case post the outline (and routing) for the record and proceed straight to writing without waiting.

## Write to `reports/<id>/digest.json` — append or merge
Per the routing chosen at the gate, write **only** the target — never other fields:

**Append** (`--append`, or the default once chosen): add one object to the top-level `deepdives` array (create it if absent). The build stacks these under a single **Deep dive** tab (count shown when >1).
```json
"deepdives": [ { "title": "Deep dive: <topic>", "added": "<today's date, YYYY-MM-DD>", "html": "..." } ]
```
**Merge** (`--into <section-key>`): append to the **existing** `sections.<key>.html`, preserving its current content, as a clearly-delimited block:
```html
<hr><h3>Deep dive: <topic> (added <today's date>)</h3>
… the worked content …
```
If `<key>` isn't a section the digest already has, stop and offer to append instead (or name a valid section). Touch only that one section's `html`.

- **HTML rules** are the same as a digest section: only `<p> <h3> <ul> <ol> <li> <strong> <code> <pre> <a> <table> <thead> <tbody> <tr> <th> <td>`; LaTeX with `\\( … \\)` / `\\[ … \\]` (escape backslashes in JSON); `<div class="callout"><span class="k">Key step</span> … </div>` for the pivotal line. Use `<h3>` for internal structure — for an appended **Deep dive** entry the title becomes the `<h2>`, so don't add your own top-level `<h2>`.
- Be grounded: cite the paper's section/equation/theorem numbers; reproduce its notation. If you fill a gap the paper leaves implicit, say so. Never invent steps you can't justify from the paper.

## Then build and report back
Run `python3 scripts/verify.py --build`, fix any `✗` failures, confirm the result rendered (the new **Deep dive** tab if you appended, or the updated section if you merged) on `docs/papers/<id>/index.html`, and tell the user to refresh. Mention anything you simplified or were unsure about.
