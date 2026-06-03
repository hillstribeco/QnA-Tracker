#!/usr/bin/env python3
from pathlib import Path
import re
root = Path(__file__).resolve().parents[1]
html = (root / "public" / "index.html").read_text(errors="replace")
sql_files = sorted((root / "supabase" / "migrations").glob("*.sql"))
print("Q&A Management App quick audit")
print("================================")
print(f"index.html lines: {html.count(chr(10)) + 1:,}")
print(f"script open tags: {len(re.findall(r'<script\\b', html, re.I))}")
print(f"script close tags: {len(re.findall(r'</script>', html, re.I))}")
print(f"inline event handlers: {len(re.findall(r'\\son[a-z]+=', html, re.I))}")
for p in sql_files:
    text = p.read_text(errors="replace")
    tables = re.findall(r'create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.([A-Za-z_][\\w]*)', text, re.I)
    print(f"{p.name}: {text.count(chr(10))+1:,} lines, {len(tables)} table declarations")
