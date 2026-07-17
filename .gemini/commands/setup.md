---
description: Set up (or update) your Reading Room profile and field config so reports are tailored to your discipline. Replaces /profile.
argument-hint: "[free text, e.g. \"bio PhD; deep methods; audience peer\"]   (or run it after Setup in the app)"
---

You are running the reader's **setup**: capture their profile + discipline and write `user/profile.json` and `user/config.json`, so the commands — which read these at runtime — tailor every report to the right field and level. Work **interactively**; do **not** use any external API or CLI commands directly. Everything you write goes under `user/` (gitignored, so app updates never overwrite it); fall back to the repo root only on an un-migrated repo, and create `user/` if it doesn't exist.

## 1. Get the intended profile + field
Two entry points:
- **In-app Setup questionnaire** — if `user/.setup-intake.json` exists (the in-app Setup posts answers there; older builds used repo-root `.setup-intake.json`), read it as the proposed profile. It may include a `fields` array (the discipline(s) picked) and/or a `tags` array (only present when the reader edited the vocabulary in the questionnaire). **Delete it once applied or abandoned**, so it isn't reused stale. Routing: the profile fields go to `user/profile.json` (§2); `fields`/`tags` go to `user/config.json` (§3).
- **Terminal** — otherwise use `$ARGUMENTS` and ask a short, **batched** set of questions for whatever's missing: **name**, **role**, **affiliation** (optional), **field(s)** (which `templates/fields/*.json` pack(s) — e.g. `ml`, `bio`, `econ-finance`), **expertise**, **interests** (optional), **defaults** (`depth` = `skim|standard|deep`, `audience` = `peer|newcomer`, `views` = subset of section keys), optional **tagline**.

**Keep the reader's involvement minimal.** Setup should *apply* the customization directly — do **not** ask them to approve each change. The only thing they see is a short **final review** (§5) of how their setup looks. (In-app Setup already collected their answers; re-asking for approval defeats the point.)

## 2. Write `user/profile.json` — apply directly
Merge with any existing profile (`user/profile.json`, else legacy `profile.json`) rather than clobbering fields they didn't set, and write it — no approval step. Shape:
```json
{ "name": "...", "role": "...", "affiliation": "...", "expertise": ["..."], "interests": ["..."],
  "defaults": {"depth": "standard", "audience": "peer", "views": []}, "tagline": "..." }
```
Write only what you have (omit empty optional fields); keep `expertise`/`interests`/`views` as arrays.

## 3. Write `user/config.json` — the field config
This is how the discipline is applied. From the chosen `fields`, the minimal form is enough — the build merges the named `templates/fields/*.json` pack(s) (tags, focus-view titles, lens, tone) at load time:
```json
{ "fields": ["bio"] }
```
If the reader wants a **custom** vocabulary or views, expand to the resolved form and edit it:
```json
{ "fields": ["bio"], "tags": ["...", "..."], "max_tags": 4,
  "sections": [{"key": "summary", "title": "Summary"}, {"key": "math", "title": "Methods & statistics"}, "..."],
  "lens": "...", "lens_key": "math", "tone": "..." }
```
If the intake carries a **`tags`** list, the reader edited the vocabulary — write it as `config.tags` (it overrides the packs' vocabulary; `verify.py` validates digests against it). If the intake carries a **`sections`** list, the reader added custom focus view(s) — write it as `config.sections` (the **full** list: the field's sections *plus* the custom ones, each `{key, title}`). You can keep `fields` alongside an explicit `tags`/`sections`: the loader's **base-wins merge** uses your explicit values and still takes lens/tone (and any unset piece) from the pack, so you don't freeze the whole config. If neither is present, write only `fields` and let the build merge the packs at load time (don't freeze a copy). Multiple fields = union of their vocabularies + a superset of sections, **in the order listed**: tags union in pack order, and each section key takes its title from the *first* pack that declares it — so put the reader's primary field first. Keep existing section **keys** stable (`summary`/`math`/`architecture`/`results`/`significance`/`reproducibility`) — only titles change per field; a custom view just needs a **new** key (adding keys is safe, only renaming an existing one blanks a tab). Write it directly — no approval step.

## 4. Do NOT edit the command files (except a genuine last resort)
The commands **read `user/config.json` and `user/profile.json` at runtime** — they pick up the field's tags, focus-view titles, lens, tone, and the reader's defaults/expertise automatically. So in the normal case **no command-file edit is needed** — this is deliberate: keeping customization in config (not in edited `.md` files) means app updates never clash with it, and the reader never has to review agent edits.

Only if the field config genuinely can't express something: make the **smallest possible** edit yourself (prefer `explain-paper.md`), never restructuring or rewording beyond that one change — and simply **note it in the final review (§5)**. Do not gate it behind per-edit approval; the reader sees it in the summary, nothing more.

## 5. Clean up, build, and show ONE final review
Delete the intake file if it was used. Run `python verify.py --build` and fix any `✗` failures. Then show a **single, concise review** of the result (the reader's only touchpoint): the resulting profile (name/role/field/defaults), the active tag vocabulary + focus views their reports will use, and — if you had to touch a command file at all — a one-line note of what and why. Close by telling them they can re-run `/setup` any time to adjust. Offer to remember the profile for future sessions if useful.
