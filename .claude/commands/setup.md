---
description: Set up (or update) your Reading Room profile and field config so reports are tailored to your discipline. Replaces /profile.
argument-hint: "[free text, e.g. \"bio PhD; deep methods; audience peer\"] [--review-profile]   (or run it after Setup in the app)"
---

You are running the reader's **setup**: capture their profile + discipline and write `user/profile.json` and `user/config.json`, so the commands — which read these at runtime — tailor every report to the right field and level. Work **interactively**; do **not** use the Anthropic API or `claude -p`. Everything you write goes under `user/` (gitignored, so app updates never overwrite it); fall back to the repo root only on an un-migrated repo, and create `user/` if it doesn't exist.

## 0. `--review-profile` — reconcile the config with the reader's full profile
The app's profile editor (avatar menu → Profile → **Edit full profile** → **Save & review**) runs `/setup --review-profile` after the reader edited **`user/profile.md`**. In this mode the Markdown file is the source of truth they just wrote — do **not** ask the questionnaire questions and do **not** rewrite the file:
1. Read `user/profile.md` in full, plus the current `user/profile.json` and `user/config.json` (resolve the active fields/tags/sections as in §1.5).
2. Derive what the profile states or clearly implies: name, role, affiliation, expertise, interests, a tagline, report defaults (`depth` / `audience` / `views` — only if the text actually says so), and the discipline (which `templates/fields/*.json` pack(s) fit — only change `fields` when the profile makes it unambiguous).
3. Apply **surgically** (the §1.5 delta rules): update only the JSON fields the profile supports, keep everything else, never reset custom tags/views. If the profile contradicts the current config (e.g. it says "biologist" but `fields` is `["ml"]`), follow the profile and say so in the review. If something is genuinely ambiguous, ask **one** short question rather than guessing.
4. Rebuild (`python3 scripts/verify.py --build`) and give the single **final review** (§5) leading with **What changed** (old → new). If nothing needed changing, say that in one line.

## 1. Get the intended profile + field
Two entry points:
- **In-app Setup questionnaire** — if `user/.setup-intake.json` exists (the in-app Setup posts answers there; older builds used repo-root `.setup-intake.json`), read it as the proposed profile. It may include a `fields` array (the discipline(s) picked) and/or a `tags` array (only present when the reader edited the vocabulary in the questionnaire). **Delete it once applied or abandoned**, so it isn't reused stale. Routing: the profile fields go to `user/profile.json` (§2); `fields`/`tags` go to `user/config.json` (§3).
- **Terminal** — otherwise use `$ARGUMENTS` and ask a short, **batched** set of questions for whatever's missing: **name**, **role**, **affiliation** (optional), **field(s)** (which `templates/fields/*.json` pack(s) — e.g. `ml`, `bio`, `econ-finance`), **expertise**, **interests** (optional), **defaults** (`depth` = `skim|standard|deep`, `audience` = `peer|newcomer`, `views` = subset of section keys), optional **tagline**.

**Keep the reader's involvement minimal.** Setup should *apply* the customization directly — do **not** ask them to approve each change. The only thing they see is a short **final review** (§5) of how their setup looks. (In-app Setup already collected their answers; re-asking for approval defeats the point.)

## 1.5 Re-running setup? Compare with the previous one first
If a previous setup exists **and it isn't the factory default** — `user/profile.json` or `user/config.json` exists and differs materially from the shipped `profile.example.json` / `config.example.json` — treat this run as an **override of an existing setup**:
- **Before writing anything**, read the current `user/profile.json` + `user/config.json` and resolve what's active today (fields, tag vocabulary, sections/views, lens/tone, defaults, tagline).
- After collecting the new answers, build a short **delta** — old → new for every changed item (field packs, depth/audience/views, tags added/removed, custom sections, profile fields) — and apply it **surgically**: keep everything the reader didn't change (never reset custom tags, sections, or views that still apply).
- Call out consequences where the delta has any: e.g. a narrowed tag vocabulary makes existing digests fail verification (tags outside the new active set) — name the affected papers; a removed view stops rendering on every report that carries it.
- The **final review (§5) must lead with a "What changed" list** (the delta), then the resulting setup.
- An existing **`user/profile.md`** (the full profile, §3.5) is **never rewritten** by a re-run — it's the reader's own document. If the new answers make it look stale, say so in the review and point them to where they can edit it.

First-time setup — no `user/` config yet, or one byte-equivalent to the shipped examples — has nothing to compare: skip this section entirely.

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
If the intake carries a **`tags`** list, the reader edited the vocabulary — write it as `config.tags` (it overrides the packs' vocabulary; `scripts/verify.py` validates digests against it). If the intake carries a **`sections`** list, the reader added custom focus view(s) — write it as `config.sections` (the **full** list: the field's sections *plus* the custom ones, each `{key, title}`). You can keep `fields` alongside an explicit `tags`/`sections`: the loader's **base-wins merge** uses your explicit values and still takes lens/tone (and any unset piece) from the pack, so you don't freeze the whole config. If neither is present, write only `fields` and let the build merge the packs at load time (don't freeze a copy). Multiple fields = union of their vocabularies + a superset of sections, **in the order listed**: tags union in pack order, and each section key takes its title from the *first* pack that declares it — so put the reader's primary field first. Keep existing section **keys** stable (`summary`/`math`/`architecture`/`results`/`significance`/`reproducibility`) — only titles change per field; a custom view just needs a **new** key (adding keys is safe, only renaming an existing one blanks a tab). Write it directly — no approval step.

## 3.5 Seed `user/profile.md` — the full profile (only if absent)
`user/profile.json` holds the structured fields; **`user/profile.md`** is the reader's **full profile** in free-form Markdown — background, current projects, what they want from reports, style preferences. The commands (`/explain-paper`, `/compare`, `/learn`, `/deep-dive`) read it when present, next to `profile.json`, to calibrate every report beyond the JSON. **If it does not exist, seed it now** from the answers (intake or terminal), with exactly these headings:
```markdown
# <name>

## Background
<role, affiliation, expertise — a sentence or two, in prose>

## What I'm working on
<interests / current projects, in the reader's own words where you have them>

## What I want from reports
<the depth / audience / views defaults in words, plus anything they said about focus, style, or what to skip>
```
Write only what you actually have — a heading with a one-line placeholder (e.g. *(fill in)*) is fine for the rest. **Never overwrite an existing `user/profile.md`**: on a re-run leave it exactly as it is, even if the profile answers changed (§1.5). No approval step — seeding it is part of applying the setup.

Tell the reader (in §5) that they can edit it any time from the app's **avatar menu → Profile → "Edit full profile"** (a full-screen editor) or in the terminal / any text editor — the commands pick up the new text on their next run.

## 4. Do NOT edit the command files (except a genuine last resort)
The commands **read `user/config.json` and `user/profile.json` at runtime** — they pick up the field's tags, focus-view titles, lens, tone, and the reader's defaults/expertise automatically. So in the normal case **no command-file edit is needed** — this is deliberate: keeping customization in config (not in edited `.md` files) means app updates never clash with it, and the reader never has to review agent edits.

Only if the field config genuinely can't express something: make the **smallest possible** edit yourself (prefer `explain-paper.md`), never restructuring or rewording beyond that one change — and simply **note it in the final review (§5)**. Do not gate it behind per-edit approval; the reader sees it in the summary, nothing more.

## 5. Clean up, build, and show ONE final review
Delete the intake file if it was used. Run `python3 scripts/verify.py --build` and fix any `✗` failures. Then show a **single, concise review** of the result (the reader's only touchpoint): the resulting profile (name/role/field/defaults), the full profile's path (`user/profile.md` — seeded now, or left as it was — editable from the app's avatar menu → Profile → "Edit full profile", or in the terminal), the active tag vocabulary + focus views their reports will use, and — if you had to touch a command file at all — a one-line note of what and why. Close by telling them they can re-run `/setup` any time to adjust. Offer to remember the profile for future sessions if useful.
