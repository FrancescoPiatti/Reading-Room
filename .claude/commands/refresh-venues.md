---
description: Check every catalogued paper still marked as an arXiv preprint to see whether it has since been published, and update its venue + BibTeX if so.
argument-hint: "[<id> ...]   (optional; default: scan all preprints)"
---

You are running a maintenance pass over the Reading Room: find papers whose citation is still the **arXiv preprint** and, for any that have since appeared at a venue, update the digest so the venue and exported BibTeX become the published conference/journal entry. The arXiv link (`source_url`) always stays. Work **interactively**; do **not** use the Anthropic API or `claude -p`.

## 1. Find the candidates
List `reports/*/digest.json`. A paper is a **preprint candidate** if it has **neither** a `published` object **nor** a raw `bibtex` string, **or** its `venue` matches `/arxiv|preprint/i`. (A paper that already carries a `published`/`bibtex` and a real venue is up to date — skip it.) If `$ARGUMENTS` lists specific ids, restrict to those (still applying the candidate test).

If there are no candidates, say so and stop.

## 2. Look up each candidate's publication status
For each candidate, check whether a peer-reviewed version now exists, using the web connector (WebFetch/WebSearch) against **DBLP** — the same source the other commands use:
- Search `https://dblp.org/search/publ/api?q=<title words>&format=json` (DBLP rate-limits; space requests out, retry on empty/non-JSON responses).
- A hit counts as **published** only if its DBLP `venue` is a real conference/journal — i.e. **not** `CoRR` (CoRR = the arXiv mirror, which means still a preprint) — **and** it is a confident match: the title is essentially identical **and** the author set agrees with the digest. Be conservative: if the match is fuzzy or only CoRR exists, treat the paper as **still a preprint** and leave it untouched. Optionally confirm the arXiv id via `http://export.arxiv.org/api/query?id_list=<id>`.
- Note that genuinely arXiv-only works (theses, some math preprints, very recent papers) will legitimately have no venue — that is the expected, common outcome; do not force a match.

## 3. Apply the updates
Apply only **confident matches** (the conservative test in step 2 — a real, non-CoRR venue, near-identical title, agreeing authors). When in doubt, leave the paper untouched. For each confident match, fetch the canonical entry `https://dblp.org/rec/<key>.bib` and edit ONLY these fields in its `digest.json`:
- set `bibtex` to the DBLP entry verbatim (this is used as-is and is the most accurate);
- set `venue` to a short human label (e.g. `"NeurIPS 2024"`, `"ICML 2023"`, `"JMLR 2022"`);
- optionally also set `year` if the published year differs.
Do **not** change `source_url` (keep the arXiv abstract link), `tags`, `sections`, `cites`, `status`, `priority`, or anything else. If DBLP is unreachable for a confirmed match, fall back to the structured `published` object (`{type, venue, year}`) with only fields you are sure of — never hand-fabricate page numbers/volume.

## 4. Build and report back
Run `python3 scripts/verify.py --build`, fix any `✗` failures, and report: which papers were updated (old → new venue), which were checked and remain preprints, and confirm the new `cite.bib` files are the published entries. Refresh `docs/index.html` to see the updated venues.
