#!/usr/bin/env python3
"""Analyze Chan Theory chapter structure."""
import json

with open("/Users/herotommyly/workspace/sclaw/chan_theory_full.json") as f:
    chapters = json.load(f)

for ch in chapters:
    lines = ch["content"].strip().split("\n")
    # Find first meaningful lines
    meaningful = [l.strip() for l in lines if l.strip() and len(l.strip()) > 10]
    preview = " | ".join(meaningful[:3])[:120]
    content_len = len(ch["content"])
    print(f"{ch['index']:3d} ({content_len:5d}ch): {preview}")
