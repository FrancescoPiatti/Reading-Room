#!/usr/bin/env python3
"""gen_gemini_commands.py — generate Gemini CLI custom commands from the Markdown sources.

Gemini CLI discovers project commands ONLY as `.gemini/commands/<name>.toml`; the Markdown
files next to them are the authoring source (kept in sync with the Claude/Codex variants).
Run after editing any `.gemini/commands/*.md`:

  python scripts/gen_gemini_commands.py        # writes/refreshes <name>.toml for every <name>.md
  python scripts/gen_gemini_commands.py --check # exit 1 if any .toml is stale (used by verify.py)

Mapping: the front-matter `description` → `description`; the body → `prompt` (a TOML literal
multi-line string, so LaTeX backslashes survive untouched) with `$ARGUMENTS` → `{{args}}`.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CMDS = ROOT / ".gemini" / "commands"


def split_front_matter(text: str):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(":")
        if _:
            meta[k.strip()] = v.strip().strip('"')
    return meta, m.group(2)


def render(md_path: Path) -> str:
    meta, body = split_front_matter(md_path.read_text(encoding="utf-8"))
    desc = meta.get("description", md_path.stem).replace('"', '\\"')
    prompt = body.strip().replace("$ARGUMENTS", "{{args}}")
    if "'''" in prompt:
        raise SystemExit(f"  ✗ {md_path.name}: the body contains ''' which a TOML literal string cannot hold")
    for bad in ("!{", "@{"):
        if bad in prompt:
            raise SystemExit(f"  ✗ {md_path.name}: '{bad}' would be expanded by Gemini (shell/file injection) — rephrase it")
    return (f"# Generated from {md_path.name} by scripts/gen_gemini_commands.py — edit the .md, then re-run it.\n"
            f'description = "{desc}"\n'
            f"prompt = '''\n{prompt}\n'''\n")


def main():
    check = "--check" in sys.argv
    stale, written = [], []
    for md in sorted(CMDS.glob("*.md")):
        toml = md.with_suffix(".toml")
        want = render(md)
        have = toml.read_text(encoding="utf-8") if toml.exists() else None
        if have == want:
            continue
        if check:
            stale.append(toml.name)
        else:
            toml.write_text(want, encoding="utf-8")
            written.append(toml.name)
    if check:
        if stale:
            print("  ✗ stale Gemini command files (run python scripts/gen_gemini_commands.py): " + ", ".join(stale))
            return 1
        print("  ✓ .gemini/commands/*.toml in sync with the .md sources")
        return 0
    print("  ✓ wrote " + (", ".join(written) if written else "nothing — all up to date"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
