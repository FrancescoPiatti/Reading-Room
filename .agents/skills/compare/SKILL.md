---
name: compare
description: "Build a side-by-side comparison page of 2–3 papers already in the Reading Room. Invoke only when the user explicitly selects $compare or /compare."
---

# Compare

## Invocation

Invoke explicitly as `$compare <id-or-arxiv> <id-or-arxiv> [<id-or-arxiv>] [--title "..."] [--approve]` in Codex or `/compare <id-or-arxiv> <id-or-arxiv> [<id-or-arxiv>] [--title "..."] [--approve]` in Reading Room work mode. In the workflow below, `$ARGUMENTS` means all text supplied after the skill or command name; never treat it as a literal value.


You are building a **comparison** entry in the Reading Room — a side-by-side breakdown of 2–3 papers that are already in the library. Work **interactively** and stop at the gate. Do **not** call an external assistant API or spawn a non-interactive assistant CLI; use the running assistant's current interactive session. Pitch the cells to the reader's profile + field config (`user/profile.json` / `user/config.json`, falling back to repo root / `config.example.json`): assume fluency in their `expertise` and apply `config.tone`.

## Input
The user passed: `$ARGUMENTS` — two or three paper ids (arXiv ids or report slugs), optionally `--title "Custom title"` and `--approve` (skip the gate's wait — post the framing/dimensions for the record and write straight away).

1. Normalize each id (lowercase, drop an `arXiv:` prefix and any `vN` suffix).
2. Confirm each one exists at `reports/<id>/digest.json`. If one is **not** in the library, stop and tell the user to run `/explain-paper <id>` first (you compare analyzed papers, not raw PDFs).
3. Read each paper's `digest.json` (and re-open the PDF in `papers/` if you need detail the digest doesn't carry).
4. Derive a `slug` for the comparison: from `--title` if given (lowercase, non-alphanumerics → `-`), else join the papers' short names (e.g. `s4-vs-mamba`).

## Gate — confirm before writing
Post and **wait for approval**:
- the papers being compared (title + year) and a one-sentence framing of *why* this comparison is interesting;
- the **dimensions** (table rows) you'll compare on — 5–9 aspects such as: core idea, key mechanism, complexity, training/inference cost, results & benchmarks, assumptions/limitations, what it's best for. Choose dimensions that actually differentiate these papers.

Only continue once the user says go — **unless `--approve` was passed**, in which case post the framing + dimensions for the record and proceed straight to writing without waiting.

## Write `compares/<slug>/compare.json`
Match this schema exactly:

```json
{
  "id": "<slug>",
  "title": "<Method A> vs. <Method B> — what changed",
  "papers": ["<id>", "<other-id>"],
  "added": "<today's date, YYYY-MM-DD>",
  "tldr": "One or two sentences on the upshot of the comparison.",
  "dimensions": [
    {"aspect": "Core idea", "cells": ["<html for paper 1>", "<html for paper 2>"]},
    {"aspect": "Complexity", "cells": ["<html>", "<html>"]}
  ],
  "verdict": {"title": "Bottom line", "html": "<p>…</p>"}
}
```

- `papers` order fixes the column order; every `dimensions[].cells` array must be in that same order and the same length (use an empty string for "not applicable").
- `cells` and `verdict.html` use the **same allowed HTML** as a report: `<p> <h3> <ul> <ol> <li> <strong> <code> <pre> <a> <table>` plus LaTeX (`\\( … \\)`, `\\[ … \\]`); keep cells tight — a few sentences or a short list, not an essay.
- Be grounded: pull claims/metrics from the digests (or the PDFs); cite section/figure numbers; never invent numbers. Note genuine uncertainty rather than guessing.
- `verdict` is optional; include it when there's a real "when to use which" takeaway.

## Then build and report back
Run `python scripts/verify.py --build` (builds, then runs QA; fix any `✗` failures), confirm `compares/<slug>/compare.json` and `docs/compare/<slug>/index.html` were written (and that each compared report now shows the comparison under **Connections → Compared in**), and tell the user to open/refresh `docs/index.html` (the comparison is listed there) or go straight to the compare page.

