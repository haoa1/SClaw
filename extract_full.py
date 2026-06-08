#!/usr/bin/env python3
"""Extract all chapters to JSON for analysis."""
import zipfile
import html.parser
import re
import json
import sys

class HTMLStripper(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.text = []
        self.in_style = False
    def handle_data(self, data):
        if not self.in_style:
            self.text.append(data)
    def handle_starttag(self, tag, attrs):
        if tag in ("style", "script"):
            self.in_style = True
        if tag in ("p", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li"):
            self.text.append("\n")
    def handle_endtag(self, tag):
        if tag in ("style", "script"):
            self.in_style = False

epub_path = "/Users/herotommyly/workspace/sclaw/缠中说禅.epub"
with zipfile.ZipFile(epub_path) as z:
    html_files = sorted([
        f for f in z.namelist()
        if f.endswith((".xhtml", ".html", ".htm"))
        and "toc" not in f.lower()
        and "nav" not in f.lower()
    ])
    chapters = []
    for i, fname in enumerate(html_files):
        raw = z.read(fname).decode("utf-8", errors="replace")
        stripper = HTMLStripper()
        stripper.feed(raw)
        text = "".join(stripper.text).strip()
        text = re.sub(r"\n{3,}", "\n\n", text)
        if len(text) > 50:
            chapters.append({"index": i+1, "file": fname, "content": text})
        sys.stderr.write(f"\r{i+1}/{len(html_files)}")
    
    outpath = "/Users/herotommyly/workspace/sclaw/chan_theory_full.json"
    with open(outpath, "w", encoding="utf-8") as f:
        json.dump(chapters, f, ensure_ascii=False, indent=2)
    print(f"\nSaved {len(chapters)} chapters to {outpath}")
