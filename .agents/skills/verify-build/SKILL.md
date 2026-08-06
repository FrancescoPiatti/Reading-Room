---
name: verify-build
description: "Run build QA on the Reading Room (reports, generated docs/, BibTeX, and theme contrast). Use after editing scripts/build.py, the templates/, base.css, or any digest, and as the final step of /explain-paper and /compare before telling the user it's done."
---


# Verify the Reading Room build

Run the project's QA checker and act on what it finds. This catches the failure modes that are easy to miss by eye: unresolved `{{PLACEHOLDERS}}`, broken embedded JSON, unbalanced `<script>` tags, missing `cite.bib`, stray `.txt` scratch in `papers/`, missing required sections, and WCAG AA contrast regressions in either theme — plus the authored-content checks: unbalanced HTML tags and unpaired `\( \)` / `\[ \]` LaTeX delimiters in any digest/compare/chat html, un-normalized `cites[].id`, malformed `published` metadata, tags outside the active vocabulary, and invalid field packs.

## How to run
From the repo root:

```
python scripts/verify.py --build
```

`--build` runs `python scripts/build.py` first, then verifies the freshly generated `docs/`. Drop `--build` to check an already-built tree. Exit code is non-zero if any **failure** (not warning) is found.

## Reading the output
- `✓` pass · `!` warning (non-blocking, e.g. a digest missing the `significance` section) · `✗` failure.
- **Failures must be fixed before reporting a task complete.** Common causes:
  - *unresolved placeholder* → a template `{{TOKEN}}` with no matching key in the corresponding `render_*` in `scripts/build.py`.
  - *embedded blob invalid* → a `</`-in-data escaping slip in `scripts/build.py` (`render_index`/`render_graph`/`render_library`/`account_block` all guard with `.replace("</", "<\\/")`).
  - *contrast `< 4.5`* → a token in `:root` or `[data-theme="dark"]` in `templates/base.css` needs adjusting; re-run until both themes pass.
- Warnings are advisory — mention them to the user but they don't block.

## When to use
- As the **last step** of `/explain-paper`, `/compare`, and `/learn`, in place of (or right after) a bare `python scripts/build.py`.
- After any change to a **build input**: `scripts/build.py`, `templates/*` (incl. `templates/fields/*.json` and `account.html`), `base.css`, `user/config.json`, or a `digest.json` / `compare.json`.
- **Decision rule:** edited a build input → run this before calling the task done.
- **Skip it** when you only touched non-build files: `AGENTS.md`, `.agents/skills/*`, `.codex/config.*`, `user/profile.json`, or `scripts/verify.py` itself.

If `scripts/verify.py` itself errors (not a check failure), the QA script is out of sync with the build — fix the script, since a green build with a broken checker is worse than no checker.
