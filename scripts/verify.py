#!/usr/bin/env python3
"""
verify.py — build QA for the Reading Room (pure stdlib, no deps).

Runs the checks that are easy to forget by hand:
  • every digest is valid JSON with required fields + required sections
  • authored HTML has balanced tags and paired \( \) / \[ \] LaTeX delimiters
  • cites[].id are normalized arXiv ids; `published` metadata is well-formed
  • field packs (templates/fields/*.json) carry the keys the loader expects
  • no extracted .txt scratch left in papers/
  • `python scripts/build.py` produces no leftover {{PLACEHOLDERS}} in docs/
  • embedded data blobs (CATALOGUE / GRAPH / LIBRARY) parse as JSON
  • <script> tags are balanced on every generated page
  • per-paper cite.bib exists; comparison pages reference real papers
  • every themed color pair in base.css meets WCAG AA contrast

Usage:
  python scripts/verify.py            # assumes docs/ is already built
  python scripts/verify.py --build    # run scripts/build.py first, then verify
Exit code is non-zero if any check fails (CI-friendly).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent   # scripts/ -> repo root
REPORTS = ROOT / "reports"
COMPARES = ROOT / "compares"
CHATS = ROOT / "chats"
PAPERS = ROOT / "papers"
TEMPLATES = ROOT / "templates"
DOCS = ROOT / "docs"

REQUIRED_DIGEST_FIELDS = ("id", "title", "sections")

# Tag vocabulary, cap, and required sections come from build.py's config loader so
# there is one definition AND they reflect the user's active field config
# (user/config.json, or the merged shipped field packs). Falls back gracefully.
try:
    from build import load_config, tag_vocabulary, max_tags, required_sections
    _CFG = load_config()
    TAG_VOCABULARY = set(tag_vocabulary(_CFG))
    MAX_TAGS = max_tags(_CFG)
    REQUIRED_SECTIONS = tuple(required_sections(_CFG))
except Exception:
    TAG_VOCABULARY, MAX_TAGS, REQUIRED_SECTIONS = set(), 4, ("summary", "significance")

# (foreground token, background token, is-large-text) pairs that carry meaning.
CONTRAST_PAIRS = [
    ("--ink", "--bg", False),
    ("--ink-soft", "--bg", False),
    ("--ink-faint", "--bg", False),
    ("--ink", "--bg-raised", False),
    ("--ink", "--bg-card", False),
    ("--accent", "--bg", False),
    ("--link", "--bg", False),
    ("--bg", "--accent", False),        # text sitting on an accent fill (read badge, pressed chip)
]

PASS, FAIL, WARN = "✓", "✗", "!"


class Report:
    def __init__(self):
        self.fails = 0
        self.warns = 0

    def ok(self, msg):
        print(f"  {PASS} {msg}")

    def warn(self, msg):
        self.warns += 1
        print(f"  {WARN} {msg}")

    def fail(self, msg):
        self.fails += 1
        print(f"  {FAIL} {msg}")

    def section(self, name):
        print(f"\n{name}")


# ----------------------------- colour maths --------------------------------

def _srgb(c):
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def _lum(hex6):
    h = hex6.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * _srgb(r) + 0.7152 * _srgb(g) + 0.0722 * _srgb(b)


def contrast(fg, bg):
    l1, l2 = _lum(fg), _lum(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def parse_theme_tokens(css):
    """Return {'light': {...}, 'dark': {...}} of hex colour tokens.
    Dark inherits from light then overrides (mirrors the cascade)."""
    def block(selector):
        m = re.search(re.escape(selector) + r"\s*\{(.*?)\}", css, re.S)
        return m.group(1) if m else ""

    def hexes(body):
        out = {}
        for name, val in re.findall(r"(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;", body):
            out[name] = val
        return out

    light = hexes(block(":root"))
    dark = dict(light)
    dark.update(hexes(block('[data-theme="dark"]')))
    return {"light": light, "dark": dark}


# ------------------------------- checks ------------------------------------

def check_digests(r):
    r.section("Digests")
    paths = sorted(REPORTS.glob("*/digest.json")) if REPORTS.exists() else []
    if not paths:
        r.warn("no digests found under reports/")
        return
    for p in paths:
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            r.fail(f"{p.parent.name}: invalid JSON ({e})")
            continue
        miss = [k for k in REQUIRED_DIGEST_FIELDS if not d.get(k)]
        if miss:
            r.fail(f"{p.parent.name}: missing field(s) {miss}")
            continue
        secs = d.get("sections") or {}
        smiss = [s for s in REQUIRED_SECTIONS if not secs.get(s, {}).get("html")]
        if smiss:
            r.warn(f"{p.parent.name}: missing required section(s) {smiss}")
        else:
            r.ok(f"{p.parent.name}: valid, required sections present")
        dd = d.get("deepdives")
        if dd is not None:
            if not isinstance(dd, list) or any(not isinstance(e, dict) or not e.get("html") for e in dd):
                r.fail(f"{p.parent.name}: deepdives must be a list of objects each with non-empty html")
            else:
                r.ok(f"{p.parent.name}: {len(dd)} deep dive(s)")
        tags = d.get("tags") or []
        if TAG_VOCABULARY:
            unknown = [t for t in tags if t not in TAG_VOCABULARY]
            if unknown:
                r.fail(f"{p.parent.name}: tag(s) outside the controlled vocabulary {unknown} "
                       f"— use only {sorted(TAG_VOCABULARY)}")
            if len(tags) > MAX_TAGS:
                r.warn(f"{p.parent.name}: {len(tags)} tags (cap {MAX_TAGS}) — keep tags broad and few")


# ---- authored-HTML checks: the mistakes an AI actually makes at 2am ----------
# Digest/compare/chat html is agent-authored and rendered verbatim, so an unbalanced
# tag or an unpaired LaTeX delimiter passes JSON validation but breaks the page.

_VOID_TAGS = {"br", "hr", "img", "input", "wbr", "col", "source", "track", "area"}
_TAG_RE = re.compile(r"<(/?)([a-zA-Z][a-zA-Z0-9]*)((?:\"[^\"]*\"|'[^']*'|[^>\"'])*)>")


def _html_balance_errors(fragment):
    """Tag-balance problems in an authored HTML fragment (best-effort, no parser deps)."""
    stack, errors = [], []
    for m in _TAG_RE.finditer(fragment):
        closing, name, attrs = m.group(1), m.group(2).lower(), m.group(3)
        if name in _VOID_TAGS or attrs.rstrip().endswith("/"):
            continue
        if not closing:
            stack.append(name)
        elif stack and stack[-1] == name:
            stack.pop()
        elif name in stack:
            while stack and stack[-1] != name:
                errors.append(f"unclosed <{stack.pop()}>")
            stack.pop()
        else:
            errors.append(f"stray </{name}>")
    errors.extend(f"unclosed <{t}>" for t in reversed(stack))
    return errors


def _latex_errors(fragment):
    out = []
    for o, c, kind in ((r"\\\(", r"\\\)", r"\( \)"), (r"\\\[", r"\\\]", r"\[ \]")):
        no, nc = len(re.findall(o, fragment)), len(re.findall(c, fragment))
        if no != nc:
            out.append(f"unpaired LaTeX {kind} delimiters ({no} open vs {nc} close)")
    return out


_ACTIVE_RE = [
    (re.compile(r"<\s*(script|iframe|object|embed|form|link|meta|style|base|template)\b", re.I),
     "active element (<script>/<iframe>/…) in authored HTML"),
    (re.compile(r"\son\w+\s*=", re.I), "inline event handler (on…=) in authored HTML"),
    (re.compile(r"(?:href|src|action)\s*=\s*[\"']?\s*(?:javascript|vbscript|data)\s*:", re.I),
     "javascript:/data: URL in authored HTML"),
]


def _active_html_errors(frag):
    """Active content is never allowed: the app serves these pages on the same origin as its
    terminal socket, so a script in a report would be a shell. build.py strips it; this fails."""
    return [msg for rx, msg in _ACTIVE_RE if rx.search(frag or "")]


def _authored_fragments(name, data):
    """Yield (label, html) for every authored HTML field in a digest/compare/chat."""
    for key, sec in (data.get("sections") or {}).items():
        if isinstance(sec, dict) and sec.get("html"):
            yield f"{name} section '{key}'", sec["html"]
    for i, dd in enumerate(data.get("deepdives") or []):
        if isinstance(dd, dict) and dd.get("html"):
            yield f"{name} deepdive [{i}]", dd["html"]
    for dim in data.get("dimensions") or []:
        for j, cell in enumerate(dim.get("cells") or []):
            if cell:
                yield f"{name} '{dim.get('aspect', '?')}' cell [{j}]", cell
    v = data.get("verdict")
    if isinstance(v, dict) and v.get("html"):
        yield f"{name} verdict", v["html"]
    if name.startswith("chat") and data.get("html"):
        yield f"{name} body", data["html"]


def _norm_id(raw):
    s = str(raw).strip().lower()
    if s.startswith("arxiv:"):
        s = s[6:].strip()
    return re.sub(r"v\d+$", "", s)


def check_authored_html(r):
    r.section("Authored HTML / LaTeX")
    sources = ([("digest " + p.parent.name, p) for p in sorted(REPORTS.glob("*/digest.json"))]
               + [("compare " + p.parent.name, p) for p in sorted(COMPARES.glob("*/compare.json"))]
               + [("chat " + p.parent.name, p) for p in sorted(CHATS.glob("*/chat.json"))])
    if not sources:
        r.warn("nothing to check (no digests / compares / chats)")
        return
    clean = 0
    for name, path in sources:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue   # already reported by the digest/compare checks
        bad = False
        for label, frag in _authored_fragments(name, data):
            for e in _active_html_errors(frag):
                r.fail(f"{label}: {e}")
                bad = True
            for e in _html_balance_errors(frag):
                r.fail(f"{label}: {e}")
                bad = True
            for e in _latex_errors(frag):
                r.fail(f"{label}: {e}")
                bad = True
        if not bad:
            clean += 1
    if clean == len(sources):
        r.ok(f"balanced tags + paired LaTeX delimiters across {clean} document(s)")


def check_citations_meta(r):
    """cites[].id normalization + `published` schema — both silently break
    downstream features (graph edges / BibTeX) when malformed."""
    r.section("Citations & published metadata")
    paths = sorted(REPORTS.glob("*/digest.json")) if REPORTS.exists() else []
    if not paths:
        r.warn("no digests to check")
        return
    clean = True
    for p in paths:
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        name = p.parent.name
        for c in d.get("cites") or []:
            raw = c.get("id") if isinstance(c, dict) else c
            if not raw:
                r.fail(f"{name}: cites entry without an id: {c!r}")
                clean = False
                continue
            if str(raw) != _norm_id(raw):
                r.warn(f"{name}: cites id '{raw}' is not normalized — use '{_norm_id(raw)}' "
                       f"(lowercase, no arXiv: prefix, no vN suffix)")
                clean = False
        pub = d.get("published")
        if pub is not None:
            if not isinstance(pub, dict):
                r.fail(f"{name}: `published` must be an object")
                clean = False
                continue
            typ = pub.get("type", "inproceedings")
            if typ not in ("article", "inproceedings"):
                r.fail(f"{name}: published.type '{typ}' — use 'article' or 'inproceedings'")
                clean = False
            for k in ("venue", "year"):
                if not pub.get(k):
                    r.warn(f"{name}: published.{k} missing — the BibTeX entry will be incomplete")
                    clean = False
            unknown = sorted(set(pub) - {"type", "venue", "year", "volume", "number",
                                         "pages", "publisher"})
            if unknown:
                r.warn(f"{name}: published key(s) {unknown} are ignored by the BibTeX builder")
                clean = False
    if clean:
        r.ok(f"cites normalized + published metadata well-formed across {len(paths)} digest(s)")


def check_field_packs(r):
    r.section("Field packs")
    fields_dir = TEMPLATES / "fields"
    packs = sorted(fields_dir.glob("*.json")) if fields_dir.exists() else []
    if not packs:
        r.warn("no field packs under templates/fields/")
        return
    try:
        from build import PACK_KEYS
    except Exception:
        PACK_KEYS = {"field", "label", "tags", "max_tags", "sections",
                     "required_sections", "lens", "lens_key", "tone", "aliases"}
    for p in packs:
        try:
            pack = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            r.fail(f"fields/{p.name}: invalid JSON ({e})")
            continue
        problems = False
        missing = [k for k in ("field", "label", "tags", "sections") if not pack.get(k)]
        if missing:
            r.fail(f"fields/{p.name}: missing key(s) {missing}")
            problems = True
        unknown = sorted(set(pack) - PACK_KEYS)
        if unknown:
            r.warn(f"fields/{p.name}: unknown key(s) {unknown} have no effect")
            problems = True
        if any(not isinstance(s, dict) or not s.get("key") for s in pack.get("sections", [])):
            r.fail(f"fields/{p.name}: every sections[] entry needs a 'key'")
            problems = True
        if not problems:
            r.ok(f"fields/{p.name}: valid ({len(pack.get('tags', []))} tags)")


def check_no_scratch(r):
    r.section("Scratch files")
    stray = list(PAPERS.glob("*.txt")) if PAPERS.exists() else []
    if stray:
        r.fail(f"extracted .txt left in papers/: {[s.name for s in stray]}")
    else:
        r.ok("no .txt scratch in papers/")


def html_pages():
    if not DOCS.exists():
        return []
    return ([DOCS / "index.html"]
            + [p for p in (DOCS / "library.html", DOCS / "graph.html") if p.exists()]
            + sorted(DOCS.glob("papers/*/index.html"))
            + sorted(DOCS.glob("compare/*/index.html"))
            + sorted(DOCS.glob("chat/*/index.html")))


def check_placeholders(r):
    r.section("Template placeholders")
    pages = html_pages()
    if not pages:
        r.fail("docs/ has no pages — run scripts/build.py first")
        return
    bad = False
    for p in pages:
        left = set(re.findall(r"\{\{[A-Z_]+\}\}", p.read_text(encoding="utf-8")))
        if left:
            bad = True
            r.fail(f"{p.relative_to(DOCS)}: unresolved {sorted(left)}")
    if not bad:
        r.ok(f"no leftover placeholders across {len(pages)} page(s)")


def check_embedded_json(r):
    r.section("Embedded data blobs")
    blobs = {"index.html": "CATALOGUE", "graph.html": "GRAPH", "library.html": "LIBRARY"}
    for fname, var in blobs.items():
        path = DOCS / fname
        if not path.exists():
            continue
        h = path.read_text(encoding="utf-8")
        m = re.search(r"const " + var + r" = (.*?);\s*\n", h, re.S)
        if not m:
            r.fail(f"{fname}: could not locate `const {var}`")
            continue
        try:
            json.loads(m.group(1).replace("<\\/", "</"))
            r.ok(f"{fname}: {var} parses")
        except json.JSONDecodeError as e:
            r.fail(f"{fname}: {var} invalid ({e})")


def check_scripts_balanced(r):
    r.section("Script tag balance")
    bad = False
    for p in html_pages():
        h = p.read_text(encoding="utf-8")
        o = len(re.findall(r"<script\b", h))
        c = len(re.findall(r"</script>", h))
        if o != c:
            bad = True
            r.fail(f"{p.relative_to(DOCS)}: {o} <script> vs {c} </script>")
    if not bad:
        r.ok("every page has balanced <script> tags")


def check_gemini_commands(r):
    """Gemini CLI only loads .gemini/commands/*.toml; they are generated from the .md sources."""
    r.section("Gemini command files")
    gen = ROOT / "scripts" / "gen_gemini_commands.py"
    if not gen.exists():
        r.warn("scripts/gen_gemini_commands.py missing")
        return
    import subprocess
    p = subprocess.run([sys.executable, str(gen), "--check"], capture_output=True, text=True)
    if p.returncode == 0:
        r.ok("every .gemini/commands/*.md has an up-to-date .toml")
    else:
        r.fail((p.stdout or p.stderr).strip() or "gen_gemini_commands.py --check failed")


def check_cite_and_compares(r):
    r.section("BibTeX & comparisons")
    reports = sorted(DOCS.glob("papers/*/index.html"))
    missing = [p.parent.name for p in reports if not (p.parent / "cite.bib").exists()]
    if missing:
        r.fail(f"cite.bib missing for: {missing}")
    elif reports:
        r.ok(f"cite.bib present for all {len(reports)} report(s)")

    if COMPARES.exists():
        ids = {p.parent.name for p in REPORTS.glob("*/digest.json")}
        for cp in sorted(COMPARES.glob("*/compare.json")):
            try:
                c = json.loads(cp.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                r.fail(f"{cp.parent.name}: invalid JSON ({e})")
                continue
            unknown = [p for p in c.get("papers", [])
                       if re.sub(r"v\d+$", "", str(p).lower().replace("arxiv:", "")) not in ids]
            if unknown:
                r.warn(f"compare {c.get('id')}: references non-library paper(s) {unknown}")
            else:
                r.ok(f"compare {c.get('id')}: all papers in library")
            # optional `focus` (the --focus question/topic): plain text, rendered escaped
            focus = c.get("focus")
            if focus is not None and not isinstance(focus, str):
                r.warn(f"compare {c.get('id')}: 'focus' should be a plain string "
                       f"(got {type(focus).__name__}); it is ignored by the build")

    if CHATS.exists():
        cids = {p.parent.name for p in REPORTS.glob("*/digest.json")}
        for cp in sorted(CHATS.glob("*/chat.json")):
            try:
                c = json.loads(cp.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                r.fail(f"{cp.parent.name}: invalid JSON ({e})")
                continue
            if not c.get("html"):
                r.fail(f"chat {c.get('id')}: missing html")
                continue
            unknown = [p for p in c.get("papers", [])
                       if re.sub(r"v\d+$", "", str(p).lower().replace("arxiv:", "")) not in cids]
            if unknown:
                r.warn(f"chat {c.get('id')}: references non-library paper(s) {unknown}")
            else:
                r.ok(f"chat {c.get('id')}: all papers in library")


def check_contrast(r):
    r.section("WCAG AA contrast (base.css tokens)")
    css = (TEMPLATES / "base.css").read_text(encoding="utf-8")
    themes = parse_theme_tokens(css)
    for theme, tokens in themes.items():
        for fg, bg, large in CONTRAST_PAIRS:
            if fg not in tokens or bg not in tokens:
                r.warn(f"{theme}: token {fg if fg not in tokens else bg} not a hex value; skipped")
                continue
            ratio = contrast(tokens[fg], tokens[bg])
            need = 3.0 if large else 4.5
            label = f"{theme}: {fg} on {bg} = {ratio:.2f}:1"
            (r.ok if ratio >= need else r.fail)(label + ("" if ratio >= need else f" (< {need})"))


def main():
    if "--build" in sys.argv:
        print("Running build.py …")
        res = subprocess.run([sys.executable, str(ROOT / "scripts" / "build.py")], cwd=ROOT)
        if res.returncode != 0:
            print("build.py failed", file=sys.stderr)
            return 1

    r = Report()
    check_digests(r)
    check_authored_html(r)
    check_citations_meta(r)
    check_field_packs(r)
    check_no_scratch(r)
    check_placeholders(r)
    check_embedded_json(r)
    check_scripts_balanced(r)
    check_cite_and_compares(r)
    check_gemini_commands(r)
    check_contrast(r)

    print(f"\n{'='*48}")
    if r.fails:
        print(f"{FAIL} {r.fails} failure(s), {r.warns} warning(s)")
        return 1
    print(f"{PASS} all checks passed"
          + (f" ({r.warns} warning(s))" if r.warns else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
