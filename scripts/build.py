#!/usr/bin/env python3
"""
build.py — turn Claude-authored digests into a browsable static site.

  reports/<id>/digest.json   (source of truth, written by /explain-paper)
        |
        v   (pure-stdlib render — NO API, NO external deps)
  docs/index.html            catalogue (search + tag filter, data embedded)
  docs/catalogue.json        the index, also written standalone
  docs/papers/<id>/index.html   the report, focus views as tabs

Run:  python scripts/build.py
Then open docs/index.html directly, or push docs/ to GitHub Pages.
"""

import html
import json
import re
import shutil
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent   # scripts/ -> repo root
REPORTS = ROOT / "reports"
COMPARES = ROOT / "compares"
CHATS = ROOT / "chats"          # compacted /learn discussions (mirrors compares/)
TEMPLATES = ROOT / "templates"
DOCS = ROOT / "docs"
USER = ROOT / "user"            # gitignored, update-safe user config (Phase 0)
FIELDS = TEMPLATES / "fields"   # shipped discipline packs (Phase 2)

# Focus views, in display order. A digest may include any subset.
# Add your own here (e.g. a domain lens) and it shows up automatically.
SECTION_ORDER = [
    ("summary",         "Summary"),
    ("math",            "Math & derivations"),
    ("architecture",    "Architecture"),
    ("results",         "Results"),
    ("significance",    "Novelty & significance"),
    ("reproducibility", "Reproducibility"),
]

# Sections that every paper should carry — build prints a soft warning if missing.
REQUIRED_SECTIONS = ["summary", "significance"]

# Fields used by the catalogue search index (kept small on purpose).
INDEX_FIELDS = ["id", "title", "authors", "year", "venue", "tldr", "tags",
                "contributions", "status", "priority"]

# Reading-status vocabulary (A1). Anything else (or missing) is treated as "to-read".
STATUSES = {"to-read": "To read", "reading": "Reading", "read": "Read"}

# Controlled tag vocabulary — keep tags BROAD so the catalogue/library filters stay
# usable as the collection grows. Digests should use 2–4 of these, not paper-specific
# labels. verify.py flags any tag outside this set or more than MAX_TAGS per paper.
# Default ML vocabulary (fallback when no config declares tags — the live list comes
# from user/config.json → templates/fields/ml.json). Kept in sync with ml.json.
TAG_VOCABULARY = [
    "deep-learning",               # neural network models and training
    "theory",                      # generalization, expressivity, guarantees
    "optimization",                # optimizers, training dynamics, losses
    "generative-models",           # diffusion, GANs, flow matching, VAEs, autoregressive
    "reinforcement-learning",      # RL, control, sequential decision-making
    "natural-language-processing", # language models, text
    "computer-vision",             # images, video, perception
    "representation-learning",     # embeddings, self-supervised, transfer
    "probabilistic-methods",       # Bayesian, uncertainty, probabilistic modelling
    "efficiency",                  # compute/memory-efficient, hardware-aware, scaling
    "datasets-and-benchmarks",     # data, evaluation, benchmarks
    "reproducibility",             # code, replication, experimental rigor
]
MAX_TAGS = 4

# An external reference must be cited by at least this many in-library papers
# before it is drawn as a "ghost" node in the connections graph (docs/graph.html).
GHOST_MIN = 2
# ...and by at least this many before it is listed in the reading queue below the
# graph. A reference cited by a single paper is not yet a signal that it matters
# to the library as a whole; the queue surfaces only recurring references.
QUEUE_MIN = 2


def fail(msg: str) -> None:
    print(f"  ✗ {msg}", file=sys.stderr)


def warn(msg: str) -> None:
    print(f"  ! {msg}", file=sys.stderr)


# --- authored-HTML sanitizer -------------------------------------------------
# Digest sections, deep dives, comparison cells and discussions are HTML written
# by the assistant (or restored from someone's backup). The app serves the built
# pages on the same origin as its terminal socket, so a <script> in a report would
# be a shell on the reader's machine. Strip active content; keep the allowed
# markup (p/h3/lists/strong/code/pre/a/table/callouts) and LaTeX text untouched.
_ACTIVE_TAG = re.compile(
    r"<\s*(script|iframe|object|embed|form|link|meta|style|base|svg|math|template)\b[^>]*>.*?<\s*/\s*\1\s*>"
    r"|<\s*(script|iframe|object|embed|form|link|meta|style|base|template)\b[^>]*/?>",
    re.I | re.S)
_ON_ATTR = re.compile(r"\s+on\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)
_BAD_URL = re.compile(r"(\s(?:href|src|action|formaction|xlink:href)\s*=\s*[\"']?)\s*(?:javascript|vbscript|data)\s*:", re.I)
_SRCDOC = re.compile(r"\s+srcdoc\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", re.I)


def sanitize_fragment(frag, label=""):
    """Return the fragment with active content removed; warns when something was stripped."""
    if not isinstance(frag, str) or "<" not in frag:
        return frag
    before = frag
    frag = _ACTIVE_TAG.sub("", frag)
    frag = _ON_ATTR.sub("", frag)
    frag = _SRCDOC.sub("", frag)
    frag = _BAD_URL.sub(r"\1#blocked:", frag)
    if frag != before:
        warn(f"{label}: active HTML (script / event handler / javascript: URL) was stripped")
    return frag


def sanitize_digest(d, label):
    for key, sec in (d.get("sections") or {}).items():
        if isinstance(sec, dict) and sec.get("html"):
            sec["html"] = sanitize_fragment(sec["html"], f"{label} section '{key}'")
    for i, dd in enumerate(d.get("deepdives") or []):
        if isinstance(dd, dict) and dd.get("html"):
            dd["html"] = sanitize_fragment(dd["html"], f"{label} deepdive [{i}]")
    return d



def load_digests():
    """Returns (digests, skipped). `skipped` counts papers dropped for bad JSON or
    missing required keys, so the build can exit non-zero rather than silently
    shipping a site with a paper missing."""
    digests = []
    skipped = 0
    if not REPORTS.exists():
        return digests, skipped
    for path in sorted(REPORTS.glob("*/digest.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            fail(f"{path}: invalid JSON ({e}); skipped")
            skipped += 1
            continue
        missing = [k for k in ("id", "title", "sections") if not data.get(k)]
        if missing:
            fail(f"{path}: missing {missing}; skipped")
            skipped += 1
            continue
        # optional sidecar of your own notes — kept out of the JSON so the
        # build never clobbers your prose (A1).
        notes = path.parent / "notes.md"
        data["_notes"] = notes.read_text(encoding="utf-8").strip() if notes.exists() else ""
        try:
            data["_updated"] = int(path.stat().st_mtime)     # catalogue/library "recently updated" sort
        except OSError:
            data["_updated"] = 0
        digests.append(sanitize_digest(data, f"digest {path.parent.name}"))
    return digests, skipped


def tag_html(tags):
    return "".join(f'<span class="tag">{html.escape(t)}</span>' for t in (tags or []))


def status_of(d):
    s = (d.get("status") or "to-read").strip().lower()
    return s if s in STATUSES else "to-read"


def status_edit_html(d):
    """Editable status + priority widget. The digest values are the defaults;
    the user's choices persist in localStorage and are hydrated by JS on load."""
    return (f'<span class="statusedit" data-id="{html.escape(d["id"])}" '
            f'data-status="{status_of(d)}" data-prio="{int(d.get("priority") or 0)}"></span>')


def notes_html(text):
    """Tiny, safe Markdown-ish: paragraphs, `- ` bullet blocks, **bold**, `code`."""
    if not text:
        return ""
    out = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.splitlines()
        if lines and all(re.match(r"\s*-\s+", ln) for ln in lines):
            items = "".join(f"<li>{_inline(ln)}</li>" for ln in
                             (re.sub(r"^\s*-\s+", "", x) for x in lines))
            out.append(f"<ul>{items}</ul>")
        else:
            out.append("<p>" + "<br>".join(_inline(ln) for ln in lines) + "</p>")
    return "".join(out)


def _inline(s):
    s = html.escape(s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


def _bib_key(d):
    authors = d.get("authors") or []
    parts = authors[0].split() if authors else []          # guard: empty/whitespace author would IndexError
    last = re.sub(r"[^A-Za-z0-9]", "", parts[-1]).lower() if parts else "anon"
    year = d.get("published", {}).get("year") or d.get("year") or ""
    words = re.sub(r"[^a-z0-9 ]", "", d.get("title", "").lower()).split()
    first = next((w for w in words if w not in {"a", "an", "the", "on", "of", "for"}), "paper")
    return f"{last}{year}{first}"


def make_bibtex(d):
    """The citation entry. Priority:
       1. a raw `bibtex` override (use the canonical published entry verbatim);
       2. structured `published` -> @inproceedings/@article (the journal/venue ref);
       3. fall back to an arXiv @misc.
    The arXiv link still lives in `source_url` regardless."""
    key = _bib_key(d)
    if d.get("bibtex"):
        return key, d["bibtex"].strip()

    authors = d.get("authors") or []
    pub = d.get("published")
    if pub:
        typ = pub.get("type", "inproceedings")
        venue_field = "journal" if typ == "article" else "booktitle"
        fields = [("title", d.get("title", ""))]
        if authors:
            fields.append(("author", " and ".join(authors)))
        if pub.get("venue"):
            fields.append((venue_field, pub["venue"]))
        yr = pub.get("year") or d.get("year")
        if yr:
            fields.append(("year", str(yr)))
        for k in ("volume", "number", "pages", "publisher"):
            if pub.get(k):
                fields.append((k, str(pub[k])))
        if d.get("source_url"):
            fields.append(("url", d["source_url"]))
        body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields if v)
        return key, f"@{typ}{{{key},\n{body}\n}}"

    aid = norm_id(d["id"])
    is_arxiv = bool(re.match(r"^\d{4}\.\d{4,5}$", aid)) or "/" in aid
    fields = [("title", d.get("title", ""))]
    if authors:
        fields.append(("author", " and ".join(authors)))
    if d.get("year"):
        fields.append(("year", str(d["year"])))
    if is_arxiv:
        fields += [("eprint", aid), ("archivePrefix", "arXiv")]
    if d.get("venue"):
        fields.append(("note", d["venue"]))
    if d.get("source_url"):
        fields.append(("url", d["source_url"]))
    body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields)
    return key, f"@misc{{{key},\n{body}\n}}"


def cite_html(bibtex):
    return (
        '<div class="cite">'
        '<button class="cite-btn" type="button" aria-expanded="false">Cite</button>'
        '<a class="cite-dl" href="cite.bib" download>.bib</a>'
        f'<pre class="cite-box" hidden><code>{html.escape(bibtex)}</code></pre>'
        '</div>'
    )


def _link_list(ids, lib):
    out = []
    for tid in ids:
        od = lib.get(tid)
        if od:
            out.append(f'<li><a href="../{html.escape(od["id"])}/index.html">'
                       f'{html.escape(od["title"])}</a></li>')
    return "".join(out)


def appendix_html(d, rel, lib):
    blocks = []
    notes = notes_html(d.get("_notes", ""))
    if notes:
        blocks.append(f'<section class="notes"><h2>My notes</h2>{notes}</section>')

    conn = []
    if rel.get("cites"):
        conn.append('<div class="conn-group"><h3>Cites in your library</h3>'
                    f'<ul>{_link_list(rel["cites"], lib)}</ul></div>')
    if rel.get("cited_by"):
        conn.append('<div class="conn-group"><h3>Cited by</h3>'
                    f'<ul>{_link_list(rel["cited_by"], lib)}</ul></div>')
    seen = set(rel.get("cites", [])) | set(rel.get("cited_by", []))
    related = [r for r in rel.get("related", []) if r not in seen][:6]
    if related:
        conn.append('<div class="conn-group"><h3>Related by tags</h3>'
                    f'<ul>{_link_list(related, lib)}</ul></div>')
    if rel.get("compared_in"):
        items = "".join(
            f'<li><a href="../../compare/{html.escape(c["id"])}/index.html">'
            f'{html.escape(c["title"])}</a></li>' for c in rel["compared_in"])
        conn.append(f'<div class="conn-group"><h3>Compared in</h3><ul>{items}</ul></div>')
    if rel.get("discussed_in"):
        items = "".join(
            f'<li><a href="../../chat/{html.escape(c["id"])}/index.html">'
            f'{html.escape(c["title"])}</a></li>' for c in rel["discussed_in"])
        conn.append(f'<div class="conn-group"><h3>Discussed in</h3><ul>{items}</ul></div>')
    if conn:
        blocks.append('<section class="connections"><h2>Connections</h2>'
                      f'<div class="conn-grid">{"".join(conn)}</div></section>')
    if not blocks:
        return ""
    return f'<div class="appendix">{"".join(blocks)}</div>'


def render_report(d, base_css, rel, lib):
    eyebrow = " · ".join(str(x) for x in (d.get("venue"), d.get("year")) if x) or "paper"
    authors = ", ".join(d.get("authors", []))
    src = d.get("source_url")
    meta_line = f'<a href="{html.escape(src)}">{html.escape(src)}</a>' if src else ""

    tabs, panels, used = [], [], set()

    def add_tab(title, body):
        sel = "true" if not tabs else "false"
        tabs.append(f'<button class="tab" role="tab" aria-selected="{sel}" '
                    f'tabindex="{0 if sel=="true" else -1}">{title}</button>')
        active = " is-active" if not panels else ""
        panels.append(f'<section class="panel{active}" role="tabpanel">{body}</section>')

    sections = d.get("sections") or {}
    for key, default_title in section_order():
        sec = sections.get(key)
        used.add(key)
        if sec and sec.get("html"):
            add_tab(html.escape(sec.get("title", default_title)), sec["html"])
    # any custom sections (e.g. an attention-lens focus) render after the rest
    for key, sec in sections.items():
        if key in used or not sec or not sec.get("html"):
            continue
        add_tab(html.escape(sec.get("title", key.replace("_", " ").title())), sec["html"])

    # incremental deep dives (added by /deep-dive) — one tab holding all entries
    dives = [e for e in (d.get("deepdives") or []) if e.get("html")]
    if dives:
        entries = "\n".join(
            f'<section class="deepdive-entry"><h2>{html.escape(e.get("title", "Deep dive"))}</h2>'
            + (f'<p class="dd-meta">added {html.escape(e["added"])}</p>' if e.get("added") else "")
            + e["html"] + "</section>"
            for e in dives)
        label = "Deep dive" + (f" ({len(dives)})" if len(dives) > 1 else "")
        add_tab(label, entries)

    _, bibtex = make_bibtex(d)
    tmpl = (TEMPLATES / "report.html.tmpl").read_text(encoding="utf-8")
    repl = {
        "{{BASE_CSS}}": base_css,
        "{{TITLE_TEXT}}": html.escape(d["title"]),
        "{{EYEBROW}}": html.escape(eyebrow),
        "{{AUTHORS}}": html.escape(authors),
        "{{META_LINE}}": meta_line,
        "{{STATUS_BADGE}}": status_edit_html(d),
        "{{LEAD}}": html.escape(d.get("tldr", "")),
        "{{TAGS}}": tag_html(d.get("tags")),
        "{{CITE}}": cite_html(bibtex),
        "{{TABS}}": "\n    ".join(tabs),
        "{{PANELS}}": "\n  ".join(panels),
        "{{APPENDIX}}": appendix_html(d, rel, lib),
        "{{ADDED}}": html.escape(d.get("added", "")),
    }
    for k, v in repl.items():
        tmpl = tmpl.replace(k, v)
    return tmpl, bibtex


def render_index(catalogue, base_css, compares_html="", chats_html="", profile=None):
    tmpl = (TEMPLATES / "index.html.tmpl").read_text(encoding="utf-8")
    payload = json.dumps(catalogue, ensure_ascii=False)
    # Guard against an accidental </script> inside data closing the tag early.
    payload = payload.replace("</", "<\\/")
    return (tmpl.replace("{{BASE_CSS}}", base_css)
                .replace("{{CATALOGUE_JSON}}", payload)
                .replace("{{COMPARES}}", compares_html)
                .replace("{{CHATS}}", chats_html)
                .replace("{{PROFILE_LINE}}", profile_line(profile or {})))


# ----------------------------- connections graph -----------------------------

def norm_id(raw) -> str:
    """Canonicalize an arXiv id for matching: lowercase, drop an 'arXiv:'
    prefix and any trailing version (v2). Report folder ids use the same form
    (arXiv id, dots kept), so library papers and citations resolve to one key."""
    s = str(raw).strip().lower()
    if s.startswith("arxiv:"):
        s = s[6:].strip()
    s = re.sub(r"v\d+$", "", s)
    return s


def cite_entries(d):
    """Yield (normalized_id, title) from a digest's `cites`, tolerating either
    bare id strings or {id, title} objects."""
    for c in d.get("cites") or []:
        if isinstance(c, str):
            if c.strip():
                yield norm_id(c), ""
        elif isinstance(c, dict) and c.get("id"):
            yield norm_id(c["id"]), (c.get("title") or "").strip()


def short_authors(authors):
    a = authors or []
    if not a:
        return ""
    return a[0] + " et al." if len(a) > 4 else ", ".join(a)


def build_graph(digests):
    """Compute nodes/links/queue for the connections graph.

    nodes  = analyzed papers + ghost nodes (external refs cited by >= GHOST_MIN
             distinct in-library papers).
    links  = directed A->B for every citation whose target is a node.
    queue  = external (not-yet-analyzed) references cited by >= QUEUE_MIN
             distinct in-library papers (most-cited first).
    """
    library = {norm_id(d["id"]): d for d in digests}
    dismissed = load_dismissed()

    citers = {}      # target id -> set of in-library source ids
    ext_title = {}   # external id -> first non-empty title we saw for it
    for d in digests:
        src = norm_id(d["id"])
        seen = set()
        for tid, title in cite_entries(d):
            if not tid or tid == src or tid in seen:
                continue
            seen.add(tid)
            citers.setdefault(tid, set()).add(src)
            if tid not in library and title and tid not in ext_title:
                ext_title[tid] = title

    nodes, node_ids = [], set()
    for nid, d in library.items():
        tags = d.get("tags") or []
        nodes.append({
            "id": nid,
            "label": d.get("title", nid),
            "type": "paper",
            "url": f"papers/{d['id']}/index.html",
            "tag": tags[0] if tags else None,
            "indegree": len(citers.get(nid, ())),
            "year": d.get("year"),
            "authors": short_authors(d.get("authors")),
        })
        node_ids.add(nid)

    for tid in sorted(t for t, s in citers.items()
                      if t not in library and t not in dismissed and len(s) >= GHOST_MIN):
        cb = len(citers[tid])
        nodes.append({
            "id": tid,
            "label": ext_title.get(tid, f"arXiv:{tid}"),
            "type": "ghost",
            "url": f"https://arxiv.org/abs/{tid}",
            "tag": None,
            "indegree": cb,
            "cited_by": cb,
        })
        node_ids.add(tid)

    links = []
    for d in digests:
        src = norm_id(d["id"])
        seen = set()
        for tid, _ in cite_entries(d):
            if tid in seen or tid == src or tid not in node_ids:
                continue
            seen.add(tid)
            links.append({"source": src, "target": tid})

    queue = [{
        "id": tid,
        "title": ext_title.get(tid, ""),
        "cited_by": len(s),
        "in_graph": len(s) >= GHOST_MIN,
    } for tid, s in citers.items()
        if tid not in library and tid not in dismissed and len(s) >= QUEUE_MIN]
    queue.sort(key=lambda q: (-q["cited_by"], q["id"]))

    tags = sorted({n["tag"] for n in nodes if n.get("tag")})
    return {"nodes": nodes, "links": links, "queue": queue, "tags": tags}


def render_graph(graph, base_css):
    tmpl = (TEMPLATES / "graph.html.tmpl").read_text(encoding="utf-8")
    payload = json.dumps(graph, ensure_ascii=False).replace("</", "<\\/")
    out = tmpl.replace("{{BASE_CSS}}", base_css).replace("{{GRAPH_JSON}}", payload)
    # additive: inject the ghost-action add-on just before </body> if it exists.
    # Absent file -> output is byte-identical to before. graph.html.tmpl untouched.
    addon = TEMPLATES / "graph_addon.html"
    if addon.exists():
        out = out.replace("</body>", addon.read_text(encoding="utf-8") + "\n</body>")
    return out


# --------------------- per-report relations (A3) ----------------------------

def compute_relations(digests):
    """For each library paper: which library papers it cites, which cite it,
    and which share tags. Returns (relations_by_id, library_by_id)."""
    lib = {norm_id(d["id"]): d for d in digests}
    cited_by = {nid: [] for nid in lib}
    cites = {nid: [] for nid in lib}
    for d in digests:
        sid = norm_id(d["id"])
        seen = set()
        for tid, _ in cite_entries(d):
            if tid in lib and tid != sid and tid not in seen:
                seen.add(tid)
                cites[sid].append(tid)
                cited_by[tid].append(sid)

    rel = {}
    for nid, d in lib.items():
        tags = set(d.get("tags") or [])
        scored = sorted(
            ((len(tags & set(od.get("tags") or [])), oid)
             for oid, od in lib.items() if oid != nid),
            key=lambda x: (-x[0], x[1]))
        rel[nid] = {
            "cites": cites[nid],
            "cited_by": cited_by[nid],
            "related": [oid for n, oid in scored if n > 0],
            "compared_in": [],
            "discussed_in": [],
        }
    return rel, lib


# ------------------------- comparisons (A4) ---------------------------------

def load_compares():
    out = []
    if not COMPARES.exists():
        return out
    for path in sorted(COMPARES.glob("*/compare.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            fail(f"{path}: invalid JSON ({e}); skipped")
            continue
        if not data.get("id") or not data.get("papers"):
            fail(f"{path}: missing id/papers; skipped")
            continue
        for dim in data.get("dimensions") or []:
            dim["cells"] = [sanitize_fragment(c, f"compare {path.parent.name} cell") for c in (dim.get("cells") or [])]
        v = data.get("verdict")
        if isinstance(v, dict) and v.get("html"):
            v["html"] = sanitize_fragment(v["html"], f"compare {path.parent.name} verdict")
        out.append(data)
    return out


def render_compare(c, base_css, lib):
    papers = [norm_id(p) for p in c["papers"]]

    def col_head(pid):
        od = lib.get(pid)
        if od:
            return (f'<th><a href="../../papers/{html.escape(od["id"])}/index.html">'
                    f'{html.escape(od["title"])}</a>'
                    f'<span class="c-sub">{html.escape(", ".join(od.get("authors", [])[:2]))}'
                    f'{" · " + str(od["year"]) if od.get("year") else ""}</span></th>')
        return f'<th><a href="https://arxiv.org/abs/{html.escape(pid)}">arXiv:{html.escape(pid)}</a></th>'

    head = "<tr><th></th>" + "".join(col_head(p) for p in papers) + "</tr>"
    rows = []
    for dim in c.get("dimensions", []):
        cells = dim.get("cells", [])
        cells = (cells + [""] * len(papers))[:len(papers)]
        tds = "".join(f"<td>{cell or '—'}</td>" for cell in cells)
        rows.append(f'<tr><th class="aspect">{html.escape(dim.get("aspect", ""))}</th>{tds}</tr>')
    table = f'<div class="ctable-wrap"><table class="ctable"><thead>{head}</thead><tbody>{"".join(rows)}</tbody></table></div>'

    verdict = ""
    v = c.get("verdict")
    if v and v.get("html"):
        verdict = (f'<section class="verdict"><h2>{html.escape(v.get("title", "Bottom line"))}</h2>'
                   f'{v["html"]}</section>')

    chips = "".join(
        f'<a class="cpill" href="../../papers/{html.escape(lib[p]["id"])}/index.html">'
        f'{html.escape(lib[p]["title"])}</a>' if p in lib else
        f'<a class="cpill" href="https://arxiv.org/abs/{html.escape(p)}">arXiv:{html.escape(p)}</a>'
        for p in papers)

    # optional guiding question/topic (`/compare … --focus "…"`): a subtle callout
    # under the lead. Plain text, escaped; empty string when absent.
    _f = c.get("focus")
    focus = _f.strip() if isinstance(_f, str) else ""   # non-strings are ignored (verify.py warns)
    focus_html = (f'<p class="c-focus"><span class="k">Question</span> {html.escape(focus)}</p>'
                  if focus else "")

    tmpl = (TEMPLATES / "compare.html.tmpl").read_text(encoding="utf-8")
    repl = {
        "{{BASE_CSS}}": base_css,
        "{{TITLE_TEXT}}": html.escape(c["title"]),
        "{{LEAD}}": html.escape(c.get("tldr", "")),
        "{{FOCUS}}": focus_html,
        "{{PILLS}}": chips,
        "{{TABLE}}": table,
        "{{VERDICT}}": verdict,
        "{{ADDED}}": html.escape(c.get("added", "")),
    }
    for k, v in repl.items():
        tmpl = tmpl.replace(k, v)
    return tmpl


def build_library(digests):
    """Flat reference list (analyzed papers only for now) with a resolved
    BibTeX entry per paper for client-side export."""
    items = []
    for d in digests:
        key, bib = make_bibtex(d)
        tags = d.get("tags") or []
        items.append({
            "id": d["id"],
            "title": d.get("title", d["id"]),
            "authors": short_authors(d.get("authors")),
            "year": d.get("year"),
            "venue": d.get("venue") or "",
            "status": status_of(d),
            "tags": tags,
            "primary_tag": tags[0] if tags else "untagged",
            "bibkey": key,
            "bibtex": bib,
            "tldr": d.get("tldr") or "",      # the Library filter searches it too
            "updated": d.get("_updated") or 0,
            "url": f"papers/{d['id']}/index.html",
        })
    items.sort(key=lambda x: (-(x["year"] or 0), x["title"].lower()))
    return items


def render_library(items, base_css, profile):
    tmpl = (TEMPLATES / "library.html.tmpl").read_text(encoding="utf-8")
    payload = json.dumps(items, ensure_ascii=False).replace("</", "<\\/")
    return (tmpl.replace("{{BASE_CSS}}", base_css)
                .replace("{{LIBRARY_JSON}}", payload)
                .replace("{{PROFILE_LINE}}", profile_line(profile)))


# Active field config, resolved once in main(); the accessors below fall back to the
# module-level defaults (SECTION_ORDER / TAG_VOCABULARY / …) so the build is
# byte-identical when no user config is present.
_ACTIVE = {}


def user_path(name):
    """Resolve a user-config file. Prefer user/<name> (gitignored, update-safe), then
    the legacy repo-root <name> (so un-migrated repos keep working unchanged), then a
    shipped <stem>.example.<ext> default. Returns the user/ path if none exist."""
    cand = USER / name
    if cand.exists():
        return cand
    legacy = ROOT / name
    if legacy.exists():
        return legacy
    stem, _, ext = name.rpartition(".")
    example = ROOT / (f"{stem}.example.{ext}" if stem else f"{name}.example")
    return example if example.exists() else cand


def load_profile():
    p = user_path("profile.json")
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"{p.name}: invalid JSON ({e}); ignored")
        return {}


def load_dismissed():
    """Ghost references the reader has dismissed in the connections graph.
    Optional root-level dismissed.json — {"dismissed": [{"id": ...}, ...]} (or a
    bare list of ids). Returns a set of normalized ids the build must never
    resurface as ghost nodes (or in the reading queue). Empty/missing -> no-op,
    so the graph output is byte-identical to before when nothing is dismissed."""
    p = user_path("dismissed.json")
    if not p.exists():
        return set()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"dismissed.json: invalid JSON ({e}); ignored")
        return set()
    items = data.get("dismissed", []) if isinstance(data, dict) else data
    out = set()
    for item in items or []:
        rid = item.get("id") if isinstance(item, dict) else item
        if rid:
            out.add(norm_id(rid))
    return out


# --- field config: tag vocabulary + focus-view order + lens/tone, per discipline ---
# Resolves user/config.json (user-owned, editable); if it only names `fields`, merges
# the shipped packs under templates/fields/. Accessors fall back to the module
# defaults, so with no config present the build is byte-identical to today.
# Every key a field pack may carry. A typo'd key would otherwise silently no-op,
# which is exactly the failure mode a community-contributed pack would hit.
PACK_KEYS = {"field", "label", "tags", "max_tags", "sections", "required_sections",
             "lens", "lens_key", "tone", "aliases"}


def load_field_pack(field):
    p = FIELDS / f"{field}.json"
    if not p.exists():
        warn(f"fields/{field}.json: no such field pack; ignored "
             f"(available: {sorted(q.stem for q in FIELDS.glob('*.json'))})")
        return {}
    try:
        pack = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"fields/{field}.json: invalid JSON ({e}); ignored")
        return {}
    missing = [k for k in ("field", "label", "tags", "sections") if not pack.get(k)]
    if missing:
        warn(f"fields/{field}.json: missing key(s) {missing} — the pack only partially applies")
    unknown = sorted(set(pack) - PACK_KEYS)
    if unknown:
        warn(f"fields/{field}.json: unknown key(s) {unknown} have no effect "
             f"(valid keys: {sorted(PACK_KEYS)})")
    return pack


def merge_field_packs(fields, base=None):
    """Union the named packs: dedup tags, keep sections (declared order, first wins),
    union required_sections, take the largest cap, first pack supplies lens/tone."""
    out = dict(base or {})
    tags, secs, req, seen = [], [], [], set()
    maxt = 0
    for f in fields or []:
        pack = load_field_pack(f)
        for t in pack.get("tags", []):
            if t not in tags:
                tags.append(t)
        for s in pack.get("sections", []):
            k = s.get("key")
            if k and k not in seen:
                secs.append(s); seen.add(k)
        for rs in pack.get("required_sections", []):
            if rs not in req:
                req.append(rs)
        maxt = max(maxt, pack.get("max_tags", 0))
        for kk in ("lens", "lens_key", "tone"):
            if not out.get(kk) and pack.get(kk):
                out[kk] = pack[kk]
    # the user's explicit config (base) wins per-field; packs only fill what it omits,
    # so a config can keep its own `tags`/`sections` while still getting the pack's lens/tone.
    if tags and not out.get("tags"): out["tags"] = tags
    if secs and not out.get("sections"): out["sections"] = secs
    if req and not out.get("required_sections"): out["required_sections"] = req
    if maxt and not out.get("max_tags"): out["max_tags"] = maxt
    return out


def load_config():
    p = user_path("config.json")
    cfg = {}
    if p.exists():
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            fail(f"{p.name}: invalid JSON ({e}); ignored")
            cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    if isinstance(cfg.get("fields"), list) and cfg["fields"]:
        cfg = merge_field_packs(cfg["fields"], cfg)   # base-wins: keeps explicit tags/sections
    return cfg


def _cfg(cfg):
    # use the explicit cfg when given (even {}), else the active config; never None
    return cfg if cfg is not None else (_ACTIVE or {})


def section_order(cfg=None):
    secs = _cfg(cfg).get("sections")
    out = [(s["key"], s.get("title", s["key"].replace("_", " ").title()))
           for s in secs if isinstance(s, dict) and s.get("key")] if secs else []
    return out or SECTION_ORDER   # fall back if a pack/config has no usable sections


def tag_vocabulary(cfg=None):
    return _cfg(cfg).get("tags") or TAG_VOCABULARY


def max_tags(cfg=None):
    return _cfg(cfg).get("max_tags") or MAX_TAGS


def required_sections(cfg=None):
    return _cfg(cfg).get("required_sections") or REQUIRED_SECTIONS


def site_title(cfg=None):
    """The site's display name — header brand, page titles, credit footer.
    Set `site_title` in user/config.json to rebrand without touching code."""
    t = str(_cfg(cfg).get("site_title") or "").strip()
    return t or "Reading Room"


def profile_line(profile):
    if not profile:
        return ""
    bits = [profile.get("name"), profile.get("role"), profile.get("affiliation")]
    label = " · ".join(html.escape(str(b)) for b in bits if b)
    return f'<p class="profile-line">{label}</p>' if label else ""


def compares_block_html(compares, lib):
    """Static 'Comparisons' list injected into the catalogue (empty if none)."""
    if not compares:
        return ""
    items = []
    for c in compares:
        names = " vs. ".join(
            (lib[norm_id(p)]["title"] if norm_id(p) in lib else f"arXiv:{norm_id(p)}")
            for p in c["papers"])
        items.append(
            f'<a class="crow" href="compare/{html.escape(c["id"])}/index.html">'
            f'<span class="crow-t">{html.escape(c["title"])}</span>'
            f'<span class="crow-s">{html.escape(names)}</span></a>')
    return ('<section class="compares"><h2>Comparisons</h2>'
            f'<div class="crows">{"".join(items)}</div></section>')


# ------------------------- discussions (compacted /learn chats) --------------
# Stored and surfaced exactly like comparisons: standalone chats/<slug>/chat.json,
# their own page under docs/chat/<slug>/, and a "Discussions" list below the reading
# list. They are NEVER catalogue cards (not in CATALOGUE) and never per-paper tabs.

def load_chats():
    """Compacted /learn discussions (mirror of load_compares). Each chats/<slug>/chat.json
    is a self-contained chat record about one or more library papers."""
    out = []
    if not CHATS.exists():
        return out
    for path in sorted(CHATS.glob("*/chat.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            fail(f"{path}: invalid JSON ({e}); skipped")
            continue
        if not data.get("id") or not data.get("papers") or not data.get("html"):
            fail(f"{path}: missing id/papers/html; skipped")
            continue
        data["html"] = sanitize_fragment(data["html"], f"chat {path.parent.name}")
        out.append(data)
    return out


def render_chat(c, base_css, lib):
    papers = [norm_id(p) for p in c["papers"]]
    pills = "".join(
        f'<a class="cpill" href="../../papers/{html.escape(lib[p]["id"])}/index.html">'
        f'{html.escape(lib[p]["title"])}</a>' if p in lib else
        f'<a class="cpill" href="https://arxiv.org/abs/{html.escape(p)}">arXiv:{html.escape(p)}</a>'
        for p in papers)
    tmpl = (TEMPLATES / "chat.html.tmpl").read_text(encoding="utf-8")
    repl = {
        "{{BASE_CSS}}": base_css,
        "{{TITLE_TEXT}}": html.escape(c["title"]),
        "{{LEAD}}": html.escape(c.get("tldr", "")),
        "{{PILLS}}": pills,
        "{{BODY}}": c["html"],
        "{{ADDED}}": html.escape(c.get("added", "")),
    }
    for k, v in repl.items():
        tmpl = tmpl.replace(k, v)
    return tmpl


def chats_block_html(chats, lib):
    """Static 'Discussions' list injected into the catalogue below the reading list
    (mirror of compares_block_html) — compacted /learn chats, never paper cards."""
    if not chats:
        return ""
    items = []
    for c in chats:
        names = ", ".join(
            (lib[norm_id(p)]["title"] if norm_id(p) in lib else f"arXiv:{norm_id(p)}")
            for p in c["papers"])
        items.append(
            f'<a class="crow" href="chat/{html.escape(c["id"])}/index.html">'
            f'<span class="crow-t">{html.escape(c["title"])}</span>'
            f'<span class="crow-s">{html.escape(names)}</span></a>')
    return ('<section class="compares"><h2>Discussions</h2>'
            f'<div class="crows">{"".join(items)}</div></section>')


# --- account UI (avatar menu + Profile/Setup modals), injected on every page ----
# Purely additive: the avatar button is wrapped next to the existing theme toggle,
# and templates/account.html (the modals + script) is injected before </body>. If
# that template is absent, the page is returned unchanged.
AVATAR_BTN = (
    '<button class="rr-acct-btn" type="button" aria-label="Account menu" '
    'aria-haspopup="menu" aria-expanded="false" title="Profile and setup">'
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'
    '</svg></button>'
)
_TOGGLE_RE = re.compile(r'(<button class="theme-toggle".*?</button>)', re.S)


def account_fields():
    """Available discipline packs (field id + label) for the in-app Setup field picker."""
    out = []
    if FIELDS.exists():
        for p in sorted(FIELDS.glob("*.json")):
            try:
                pack = json.loads(p.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            out.append({"field": pack.get("field", p.stem), "label": pack.get("label", p.stem),
                        "sections": pack.get("sections", []), "tags": pack.get("tags", [])})
    return out


def account_block(profile):
    """The Profile/Setup modals + script (templates/account.html), with the profile,
    section list, and field packs embedded as JS literals. '' if the template absent."""
    tmpl = TEMPLATES / "account.html"
    if not tmpl.exists():
        return ""
    sections = [{"key": k, "title": t} for k, t in section_order()]
    fields = {"available": account_fields(), "active": (_ACTIVE.get("fields") or []),
              "tags": list(tag_vocabulary())}
    prof_json = json.dumps(profile or {}, ensure_ascii=False).replace("</", "<\\/")
    sec_json = json.dumps(sections, ensure_ascii=False).replace("</", "<\\/")
    fld_json = json.dumps(fields, ensure_ascii=False).replace("</", "<\\/")
    return (tmpl.read_text(encoding="utf-8")
            .replace("{{ACCOUNT_PROFILE_JSON}}", prof_json)
            .replace("{{ACCOUNT_SECTIONS_JSON}}", sec_json)
            .replace("{{ACCOUNT_FIELDS_JSON}}", fld_json)
            .replace("{{ACCOUNT_SITE_TITLE_JSON}}", json.dumps(site_title()).replace("</", "<\\/")))


# Creator credit shown at the bottom of every page. Attribution is fixed (this is the
# tool's author); the reader's own name/affiliation lives in the header, not here —
# and `site_title` in user/config.json renames the site without touching this.
def credit_html():
    return ('<footer class="rr-credit">'
            f'{html.escape(site_title())} · created by <strong>Francesco Piatti</strong> · '
            f'&copy; {date.today().year} Francesco Piatti'
            '</footer>')


def finalize_page(page_html, profile, depth=0):
    """Inject the account UI (wrap the theme toggle + a new avatar button in a
    cluster, add the account modals + creator credit before the final </body>),
    then resolve the page-wide placeholders: {{SITE_TITLE}} (config `site_title`)
    and {{ASSET_ROOT}} (relative prefix to docs/ for a page `depth` levels down).
    If templates/account.html is absent, only the placeholders are resolved —
    no dangling avatar button without its menu/modals."""
    block = account_block(profile)
    if block:
        page_html = _TOGGLE_RE.sub(
            lambda m: '<span class="rr-acct-cluster">' + m.group(1) + AVATAR_BTN + '</span>',
            page_html, count=1)
        # inject before the LAST </body> (the real closing tag), robust to a stray
        # "</body>" appearing earlier inside author-authored digest HTML.
        i = page_html.rfind("</body>")
        tail = credit_html() + block + "\n"
        page_html = page_html[:i] + tail + page_html[i:] if i != -1 else page_html + tail
    # {{TAGLINE}}: the catalogue's one-line subtitle. Setup stores it as
    # profile.tagline ("Catalogue tagline"); fall back to the shipped default.
    tagline = (profile or {}).get("tagline") or "Focused breakdowns of the papers worth keeping."
    return (page_html
            .replace("{{SITE_TITLE}}", html.escape(site_title()))
            .replace("{{TAGLINE}}", html.escape(tagline))
            .replace("{{ASSET_ROOT}}", "../" * depth))


# ---- self-hosted assets (fonts + vendored search/graph libraries) -----------
# Everything the pages need ships inside docs/, so the site works fully offline
# and no reading activity leaks to a CDN. MathJax stays on its (pinned, SRI-checked)
# CDN — it is several MB with fonts; without it LaTeX degrades to readable source.
VENDOR = TEMPLATES / "vendor"


def copy_assets():
    if not VENDOR.exists():
        return
    vend_out = DOCS / "assets" / "vendor"
    vend_out.mkdir(parents=True, exist_ok=True)
    for f in VENDOR.glob("*.min.js"):
        shutil.copy2(f, vend_out / f.name)
    fonts = VENDOR / "fonts"
    if fonts.exists():
        fonts_out = DOCS / "assets" / "fonts"
        fonts_out.mkdir(parents=True, exist_ok=True)
        for f in fonts.glob("*.woff2"):
            shutil.copy2(f, fonts_out / f.name)
    # tutorial / README screenshots (assets/shots/ at the repo root, committed)
    shots = ROOT / "assets" / "shots"
    if shots.exists():
        shots_out = DOCS / "assets" / "shots"
        shots_out.mkdir(parents=True, exist_ok=True)
        for f in shots.iterdir():
            if f.suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
                shutil.copy2(f, shots_out / f.name)


def page_css(base_css, depth):
    """Inline CSS for a page `depth` directories below docs/: the self-hosted
    @font-face rules (urls made relative to the page) + base.css. If the vendored
    fonts are absent the page just uses the system font stack from base.css."""
    fcss = VENDOR / "fonts.css"
    if not fcss.exists():
        return base_css
    return (fcss.read_text(encoding="utf-8").replace("{{FONT_ROOT}}", "../" * depth)
            + "\n" + base_css)


_HTML_TAG = re.compile(r"<[^>]+>")


def section_text(d, cap=2500):
    """A stripped, capped plain-text excerpt of a digest's section + deep-dive HTML,
    so catalogue search matches report bodies, not just titles/tags. Capped to keep
    the embedded catalogue payload light."""
    parts = []
    for sec in (d.get("sections") or {}).values():
        if isinstance(sec, dict) and sec.get("html"):
            parts.append(sec["html"])
    for dd in (d.get("deepdives") or []):
        if isinstance(dd, dict) and dd.get("html"):
            parts.append(dd["html"])
    txt = _HTML_TAG.sub(" ", " ".join(parts))
    return re.sub(r"\s+", " ", txt).strip()[:cap]


def main():
    global _ACTIVE
    _ACTIVE = load_config()
    base_css = (TEMPLATES / "base.css").read_text(encoding="utf-8")
    css_root = page_css(base_css, 0)   # pages at docs/ root
    css_sub = page_css(base_css, 2)    # pages two levels down (papers/, compare/, chat/)
    profile = load_profile()
    digests, skipped = load_digests()
    relations, lib = compute_relations(digests)

    for d in digests:
        missing = [s for s in required_sections()
                   if not (d.get("sections") or {}).get(s, {}).get("html")]
        if missing:
            fail(f"{d['id']}: missing recommended section(s) {missing}")

    # comparisons (A4) — load first so reports can show "Compared in"
    compares = load_compares()
    for c in compares:
        for p in c["papers"]:
            pid = norm_id(p)
            if pid in relations:
                relations[pid]["compared_in"].append(c)

    # discussions (compacted /learn chats) — load first so reports show "Discussed in"
    chats = load_chats()
    for c in chats:
        for p in c["papers"]:
            pid = norm_id(p)
            if pid in relations:
                relations[pid]["discussed_in"].append(c)

    (DOCS / "papers").mkdir(parents=True, exist_ok=True)
    copy_assets()

    catalogue = []
    for d in digests:
        out = DOCS / "papers" / d["id"]
        out.mkdir(parents=True, exist_ok=True)
        html_out, bibtex = render_report(d, css_sub, relations[norm_id(d["id"])], lib)
        (out / "index.html").write_text(finalize_page(html_out, profile, depth=2), encoding="utf-8")
        (out / "cite.bib").write_text(bibtex + "\n", encoding="utf-8")
        entry = {k: d.get(k) for k in INDEX_FIELDS if d.get(k) is not None}
        entry["text"] = section_text(d)   # full-text search over report bodies
        entry["updated"] = d.get("_updated") or 0
        catalogue.append(entry)
        print(f"  ✓ {d['id']}")

    # newest first by year
    catalogue.sort(key=lambda p: p.get("year") or 0, reverse=True)

    # comparison pages (A4)
    if compares:
        (DOCS / "compare").mkdir(parents=True, exist_ok=True)
    for c in compares:
        out = DOCS / "compare" / c["id"]
        out.mkdir(parents=True, exist_ok=True)
        (out / "index.html").write_text(finalize_page(render_compare(c, css_sub, lib), profile, depth=2), encoding="utf-8")
        print(f"  ✓ compare/{c['id']}")

    # discussion (chat) pages — one per compacted /learn chat
    if chats:
        (DOCS / "chat").mkdir(parents=True, exist_ok=True)
    for c in chats:
        out = DOCS / "chat" / c["id"]
        out.mkdir(parents=True, exist_ok=True)
        (out / "index.html").write_text(finalize_page(render_chat(c, css_sub, lib), profile, depth=2), encoding="utf-8")
        print(f"  ✓ chat/{c['id']}")

    (DOCS / "catalogue.json").write_text(
        json.dumps(catalogue, indent=2, ensure_ascii=False), encoding="utf-8")
    (DOCS / "index.html").write_text(
        finalize_page(render_index(catalogue, css_root, compares_block_html(compares, lib),
                                   chats_block_html(chats, lib), profile), profile),
        encoding="utf-8")

    # library view (grouped reference list + BibTeX export)
    library = build_library(digests)
    (DOCS / "library.json").write_text(
        json.dumps(library, indent=2, ensure_ascii=False), encoding="utf-8")
    (DOCS / "library.html").write_text(
        finalize_page(render_library(library, css_root, profile), profile), encoding="utf-8")

    # connections graph (data embedded so it works offline, like the catalogue)
    graph = build_graph(digests)
    (DOCS / "graph.json").write_text(
        json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")
    (DOCS / "graph.html").write_text(finalize_page(render_graph(graph, css_root), profile), encoding="utf-8")

    # stop Jekyll on GitHub Pages from eating folders that start with _
    (DOCS / ".nojekyll").write_text("", encoding="utf-8")

    # prune generated pages whose source is gone (a removed paper, a deleted discussion,
    # a page an update archive put back) — docs/ must mirror reports/compares/chats
    pruned = 0
    for sub, src, fname in (("papers", REPORTS, "digest.json"), ("compare", COMPARES, "compare.json"), ("chat", CHATS, "chat.json")):
        base = DOCS / sub
        if not base.exists():
            continue
        for page in base.iterdir():
            if page.is_dir() and not (src / page.name / fname).exists():
                shutil.rmtree(page, ignore_errors=True)
                pruned += 1
    if pruned:
        print(f"  • pruned {pruned} orphan page folder(s) under docs/")

    print(f"  ✓ graph: {len(graph['nodes'])} node(s), "
          f"{len(graph['links'])} edge(s), {len(graph['queue'])} queued")
    print(f"\nBuilt {len(catalogue)} report(s)"
          + (f", {len(compares)} comparison(s)" if compares else "")
          + f" → {DOCS}/index.html")

    if skipped:
        fail(f"{skipped} digest(s) SKIPPED — the site is INCOMPLETE (see messages above)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
