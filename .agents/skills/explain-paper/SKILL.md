---
name: explain-paper
description: "Read a paper (arXiv id, URL, or local PDF path) and produce a focused HTML report in the Reading Room catalogue. Invoke only when the user explicitly selects $explain-paper or /explain-paper."
---

# Explain Paper

## Invocation

Invoke explicitly as `$explain-paper <arxiv-id | arxiv-url | path/to/paper.pdf> [--views a,b,c] [--depth skim|standard|deep] [--audience peer|newcomer] [--focus "..."] [--approve]` in Codex or `/explain-paper <arxiv-id | arxiv-url | path/to/paper.pdf> [--views a,b,c] [--depth skim|standard|deep] [--audience peer|newcomer] [--focus "..."] [--approve]` in Reading Room work mode. In the workflow below, `$ARGUMENTS` means all text supplied after the skill or command name; never treat it as a literal value.


You are building one entry in a personal "Reading Room" — a catalogue of focused paper breakdowns. Work **interactively** and stop at the approval gate below. Do **not** call an external assistant API or spawn a non-interactive assistant CLI; this runs inside the running assistant's current interactive session.

## Input
The user passed: `$ARGUMENTS`

Resolve it to a PDF and an `id` slug:
- **arXiv id** (e.g. `2402.01234`, may have a version like `v2`): download with
  `curl -L -o papers/<id>.pdf https://arxiv.org/pdf/<id>.pdf`, and set `id` to the arXiv id (dots → keep, slashes → `-`). Record `source_url` as `https://arxiv.org/abs/<id>`.
- **URL to a PDF**: download it into `papers/`, derive a short `id` slug from the title later.
- **Local path**: use it directly; derive `id` from the filename (lowercase, non-alphanumerics → `-`).

Then **read the PDF** directly with the running assistant's PDF-capable file reader — render pages so you can see equations, figures, and tables. Read the whole thing, appendices included if present. (A configured PDF-viewer connector, if present, is an alternative.) Only if rendering is unavailable, fall back to a text extraction — and write it to `.cache/<id>.txt` (gitignored), **never** beside the PDF in `papers/`. Don't leave `.txt` files in `papers/`.

## Options (parse these from `$ARGUMENTS`, after the id/url/path)
All optional — fall back to the defaults if absent, and confirm your reading of them at Gate 1. If a profile exists (`user/profile.json`, else legacy `profile.json`), take unset defaults from it: `defaults.depth`, `defaults.audience`, `defaults.views`, and use the reader's `expertise` to calibrate how much background to spell out (assume fluency in their listed areas).

**Read the field config** (`user/config.json`, falling back to `config.example.json`) and tailor the report to the reader's discipline — do **not** assume ML/maths. If the config has only a `fields` array, resolve it by reading the named `templates/fields/<field>.json` pack(s) — that's the source of `tags`/`sections`/`lens`/`tone`. Use `config.tags` as the controlled tag vocabulary, `config.sections` for the focus-view keys/titles, **over-invest in the field's lens view** (`config.lens`, key `config.lens_key`), and apply `config.tone`. (The section *keys* are stable — `summary`, `math`, `architecture`, `results`, `significance`, `reproducibility` — but each field gives them its own *titles*, e.g. `math` is titled "Methods & statistics" for biology. Write the keys; the build applies the titles.)
- **`--views a,b,c`** (B1) — only author these focus sections (keys from the schema, e.g. `--views summary,math,results`). Default: every section that's relevant. Omit any section you're not writing — never emit an empty one.
- **`--depth skim|standard|deep`** (B2) — controls length/detail. `skim` = tight, headline-level; `standard` = the usual; `deep` = thorough, over-invest in the field's lens view (`config.lens_key`, e.g. `math`). Default `standard`.
- **`--audience peer|newcomer`** (B2) — `peer` assumes a PhD in the area (default); `newcomer` adds more scaffolding and defines jargon.
- **`--focus "free text"`** (B3) — a lens to pay special attention to (e.g. `--focus "the stability proof"`). Weave it through the relevant sections, and if it doesn't fit an existing view, add **one** extra custom section: pick a fresh `sections` key (e.g. `"lens"`) with a descriptive `title` — the build renders any section key, custom ones after the standard ones.
- **`--approve`** (B4) — skip the wait at Gate 1: still post the outline for the record, but proceed straight to writing the digest without pausing for confirmation. Default: off (pause at Gate 1).

## Scan the bibliography (for the connections graph)
While reading, build the paper's `cites` list (see schema) so the catalogue's connections graph (`docs/graph.html`) can link papers:
- Go through the references section. For each reference that is **important to this paper** (its direct lineage, key baselines, the methods it builds on — not every incidental citation), capture its **arXiv id** and **title**.
- Normalize each id: lowercase, drop any `arXiv:` prefix and any version suffix (`1706.03762v5` → `1706.03762`).
- Match against the existing library: list `reports/` — a reference whose id has a folder there is already analyzed and its edge resolves automatically.
- Also include important references that are **not** yet in the library. They surface as a reading queue, and become graph nodes once two of your papers cite them (or you analyze them). Skip references with no arXiv id (or note them in prose only).

## Plan the section division (skim first, then adapt)
Before drafting, **skim the whole paper** (abstract, section headings, figures, results, conclusion) to see how it is actually organised. Then design *this paper's* focus views by **starting from the reader's default `config.sections`** (what they chose at setup) and adapting to fit the paper:
- always keep `summary` + `significance`;
- keep the default views the paper genuinely supports; **drop** ones it doesn't (never emit an empty section);
- **`reproducibility` is opt-in, not a default**: write it only when the reader asked for it — `--views` includes it, `--focus` points at it, or their setup put it in `defaults.views` / config `sections` as a chosen default. Otherwise skip it even for papers with code;
- **add** a paper-specific custom view (a fresh `sections` key + a descriptive title — the build renders any key) when the paper has a major thread the defaults don't capture;
- weight depth toward the field's lens (`config.lens_key`) and calibrate to the reader's `expertise` / `audience`.

The defaults are a **starting point, not a fixed template** — this per-paper plan is what you confirm at Gate 1.

## Gate 1 — confirm before writing
Post a short outline and **wait for the user to approve or adjust**:
- title, authors, venue/year, and your one-sentence TL;DR
- 2–4 proposed `tags`, chosen ONLY from the controlled vocabulary below (these power catalogue/library search, filter, and grouping)
- the **section plan** from the step above: which focus views you'll write, which you'll skip (one phrase each on why), and any paper-specific custom view — always including `summary` + `significance`. (Respect any `--views`/`--focus`.)
- the key `cites` you found (which are already in the library vs. new to the reading queue)
- how you read any `--depth` / `--audience` / `--focus` options

Only continue once the user says go — **unless `--approve` was passed**, in which case post the outline for the record and proceed straight to writing without waiting.

## Write `reports/<id>/digest.json`
Match this schema exactly. Omit any `sections` entry you're skipping — do not include empty ones.

```json
{
  "id": "<slug>",
  "title": "...",
  "authors": ["First Last", "..."],
  "year": 2024,
  "venue": "NeurIPS 2024 | arXiv preprint | ...",
  "source_url": "https://arxiv.org/abs/...",
  "published": {"type": "inproceedings", "venue": "International Conference on Learning Representations (ICLR)", "year": 2022},
  "tldr": "One or two sentences a busy PhD peer would want.",
  "tags": ["deep-learning", "natural-language-processing", "efficiency"],
  "added": "<today's date, YYYY-MM-DD>",
  "status": "to-read",
  "priority": 0,
  "contributions": ["Crisp claim 1", "Crisp claim 2"],
  "cites": [
    {"id": "1706.03762", "title": "Attention Is All You Need"}
  ],
  "sections": {
    "summary":         {"title": "Summary",            "html": "..."},
    "math":            {"title": "Math & derivations", "html": "..."},
    "architecture":    {"title": "Architecture",       "html": "..."},
    "results":         {"title": "Results",            "html": "..."},
    "significance":    {"title": "Novelty & significance", "html": "..."},
    "reproducibility": {"title": "Reproducibility",    "html": "..."}
  }
}
```

`summary` and `significance` are **always written** (the build warns if either is missing). The rest are written when relevant (respecting any `--views`) — except `reproducibility`, which is written **only when explicitly requested** (`--views`/`--focus`/the reader's configured defaults).

**Tags — use ONLY the active controlled vocabulary** (keep them broad; pick the 2–4 that fit, never invent paper-specific tags — `scripts/verify.py` fails the build on any tag outside the set, and the catalogue/library stay usable only if tags stay general). The live list is **`config.tags`** from the field config (`user/config.json`, else `config.example.json`, else the shipped `templates/fields/*.json` packs) — **read it at runtime and use exactly those**. Don't rely on any vocabulary copied into this file (it would drift from the config and the build would reject it). For reference only, the ML pack's default vocabulary lives in `templates/fields/ml.json`.
If a paper genuinely needs a category the active vocabulary doesn't cover, propose adding it to `config.tags` (the user's field config) at Gate 1 — added deliberately, once — rather than inventing a one-off tag.

`cites` is optional but recommended: a list of `{id, title}` objects (normalized arXiv id + the cited work's title). Omit it only if the paper has no locatable arXiv references. Edges are keyed by `id`, so they resolve to existing reports automatically and light up later when you analyze a cited paper.

**Citation / BibTeX.** Always keep `source_url` pointing at the arXiv abstract page (that's the link shown on the report). But if the paper was **published** at a venue, set `published` so the exported BibTeX is the *journal/conference* entry, not the arXiv preprint:
- `published.type`: `inproceedings` (conference) or `article` (journal).
- `published.venue`: the booktitle/journal name; plus optional `year`, `volume`, `number`, `pages`, `publisher`.
- For the canonical entry, fetch it with the running assistant's web connector — DBLP exposes a stable `.bib` per paper (e.g. `https://dblp.org/rec/<key>.bib`). Set it as a raw `"bibtex": "@inproceedings{...}"` string — it's used verbatim and wins over `published`. Don't hand-fabricate page numbers / volume; if unsure, use the structured `published` fields you're confident about and leave the rest out.
- If neither is set, the build falls back to an arXiv `@misc` entry. Check whether the paper has a published version before defaulting to the preprint.

`status` (`to-read` | `reading` | `read`) and `priority` (0–3 stars) are just the **starting values** — set `status: "to-read"` and `priority: 0` for a newly added paper unless the user says otherwise. The reader changes them in the browser (a status control + clickable stars on the report page, and a status dropdown + stars on the Library page); those choices persist in `localStorage` and override the digest defaults, so don't keep hand-editing the JSON to track reading progress. Your **own running notes** for a paper live in a sidecar `reports/<id>/notes.md` (plain text + light Markdown: paragraphs, `- ` bullets, `**bold**`, `` `code` ``); the build renders them in a "My notes" block and never overwrites them.

### What each focus view is for
*(Keys are stable; `config.sections` supplies each field's titles. Below is the ML framing — adapt the content to the active field's `config.lens`/`config.tone`.)*
- **summary** — the problem, the idea, why it matters; assume a strong-but-non-specialist reader.
- **math** *(the field's lens view — title varies: "Math & derivations" for ML, "Methods & statistics" for bio, "Model & identification" for econ)* — the core quantitative content the field cares about: definitions, the central equations/estimators, and the *derivation/identification logic* (not just restated results). **Over-invest here** (`config.lens`).
- **architecture** — the structure: model/algorithm components and data flow (ML), the experimental design (bio), or the empirical strategy (econ).
- **results** — headline numbers as a `<table>`, the setup, and what the results actually support vs. overclaim.
- **significance** *(always)* — one section that puts together **(a)** what's genuinely new + the closest prior work + an honest critique (assumptions, limitations, where it might fail), and **(b)** why it matters for the field (impact, what it unlocks, the lineage it sits in). Use `<h3>` subheadings to separate novelty/critique from the field significance.
- **reproducibility** *(opt-in — only on request or when configured as a default view)* — code availability, compute, datasets, and the gotchas you'd hit reimplementing it.

### HTML authoring rules (the template styles these)
- Use only: `<p> <h2> <h3> <ul> <ol> <li> <strong> <code> <pre> <a> <table> <thead> <tbody> <tr> <th> <td>`.
- **Math**: LaTeX with `\( … \)` inline and `\[ … \]` for display. MathJax renders it. In JSON, escape backslashes (`\\(`, `\\frac`, etc.).
- **Key equation or headline result**: wrap in `<div class="callout"><span class="k">Key result</span> … </div>`.
- **Results tables**: numeric cells get `class="num"` (`<td class="num">93.7</td>`).
- Be **grounded**: cite section/figure numbers in prose (e.g. "(§4.2)") since there's no auto-citation. If a number or claim is uncertain, say so rather than inventing it. Never fabricate metrics.

## Then build and report back
Run `python scripts/verify.py --build` (builds, then runs QA). Fix any `✗` failures before continuing — only warnings are acceptable. Confirm `reports/<id>/digest.json` and `docs/papers/<id>/index.html` were written, and tell the user to open `docs/index.html` (or refresh it). Mention anything you skipped or were unsure about.
