#!/usr/bin/env python3
"""Extract every ```mermaid block from docs/*.md into docs/diagrams/<name>.mmd and render SVG with mmdc.
Usage: python3 tools/render-diagrams.py   (needs @mermaid-js/mermaid-cli: npm i -g @mermaid-js/mermaid-cli)"""
import re, subprocess, pathlib, sys, json, tempfile
root = pathlib.Path(__file__).resolve().parent.parent
out = root / "docs" / "diagrams"; out.mkdir(exist_ok=True)
cfg = pathlib.Path(tempfile.gettempdir()) / "pptr.json"
cfg.write_text(json.dumps({"args": ["--no-sandbox", "--disable-setuid-sandbox"]}))
bad = 0; n = 0
for md in sorted((root / "docs").glob("*.md")):
    for m in re.finditer(r"```mermaid\n(.*?)```", md.read_text(), re.S):
        body = m.group(1)
        name = re.search(r"%% name:\s*(\S+)", body)
        if not name: print(f"!! {md.name}: block without %% name"); bad += 1; continue
        mmd = out / f"{name.group(1)}.mmd"; mmd.write_text(body)
        svg = out / f"{name.group(1)}.svg"
        r = subprocess.run(["mmdc", "-i", str(mmd), "-o", str(svg), "-p", str(cfg), "-b", "transparent"], capture_output=True, text=True)
        n += 1
        if r.returncode != 0: bad += 1; print(f"FAIL {md.name}:{name.group(1)}\n{r.stderr[-600:]}")
        else: print(f"ok   {md.name}:{name.group(1)}")
print(f"{n-bad}/{n} diagrams rendered"); sys.exit(1 if bad else 0)
