#!/usr/bin/env python3
"""Bundle index.html + pen.css + pen.js into one page for publishing on Claude.

Inside Claude the planner saves to your Claude account and reads Google
Calendar through your Claude connector. Run from the repo root:
    python3 tools/build_artifact.py
"""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
html = (root / "index.html").read_text()
css = (root / "pen.css").read_text()
js = (root / "pen.js").read_text()
assert "</script" not in js and "</style" not in css

body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
body = body.replace('<script src="pen.js"></script>', "").strip()
# The GitHub-only pieces (install hint, Apps Script setup) stay in the markup;
# pen.js hides them when it runs inside Claude.
out = f"""<title>Pen Planner</title>
<style>
{css}
</style>
{body}
<script>
{js}
</script>
"""
dest = root / "artifact" / "pen-planner.html"
dest.write_text(out)
print(f"Wrote {dest} ({len(out):,} bytes)")
