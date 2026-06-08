#!/usr/bin/env python3
"""Extract text from the Chan Zhong Shuo Chan EPUB for analysis."""

import zipfile
import html.parser
import json
import re

epub_path = "缠中说禅.epub"

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

with zipfile.ZipFile(epub_path) as z:
    # Find all xhtml/html files, sorted
    html_files = sorted([
        f for f in z.namelist()
        if f.endswith((".xhtml", ".html", ".htm"))
        and "toc" not in f.lower()
        and "nav" not in f.lower()
    ])
    print(f"Total chapters: {len(html_files)}")
    
    # Extract all chapter content
    chapters = []
    for i, fname in enumerate(html_files):
        raw = z.read(fname).decode("utf-8", errors="replace")
        stripper = HTMLStripper()
        stripper.feed(raw)
        text = "".join(stripper.text).strip()
        # Clean up whitespace
        text = re.sub(r'\n{3,}', '\n\n', text)
        if len(text) > 50:  # Skip very small fragments
            chapters.append({
                "index": i + 1,
                "file": fname,
                "content": text,
                "word_count": len(text)
            })
    
    print(f"Non-empty chapters: {len(chapters)}")
    
    # Print chapter titles and first 200 chars of each
    for ch in chapters[:5]:
        lines = ch["content"].split("\n")
        title = lines[0][:80] if lines else "?"
        print(f"\n--- Chapter {ch['index']}: {title} ---")
        print(ch["content"][:300])
        print("...")
    
    # Print summary
    total_chars = sum(ch["word_count"] for ch in chapters)
    print(f"\n\n{'='*60}")
    print(f"Total characters: {total_chars}")
    print(f"Total chapters: {len(chapters)}")
