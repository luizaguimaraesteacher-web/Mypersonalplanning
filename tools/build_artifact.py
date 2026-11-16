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
# Personal study plan (kept out of the public repo): seeds the planner the first time it opens.
seed_file = root / "private" / "study-plan.json"
seed = ""
if seed_file.exists():
    seed_json = seed_file.read_text().replace("</", "<\\/")
    seed = f'<script type="application/json" id="studySeed">{seed_json}</script>\n'
# Which calendars to show the first time (also private).
cal_file = root / "private" / "calendars.json"
if cal_file.exists():
    seed += f'<script type="application/json" id="calSeed">{cal_file.read_text().strip().replace("</", "<\\/")}</script>\n'
out = f"""<title>Pen Planner</title>
<style>
{css}
</style>
{body}
{seed}<script>
{js}
</script>
"""
# The committed copy never carries the personal plan; the private copy (published) does.
public = out.replace(seed, "") if seed else out
dest = root / "artifact" / "pen-planner.html"
dest.write_text(public)
print(f"Wrote {dest} ({len(public):,} bytes)")
if seed:
    private = root / "private" / "pen-planner.html"
    private.write_text(out)
    print(f"Wrote {private} with the study plan ({len(out):,} bytes)")
