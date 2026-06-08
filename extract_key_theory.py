#!/usr/bin/env python3
"""Extract key theoretical chapters from Chan Theory for stock screening."""
import json

with open("/Users/herotommyly/workspace/sclaw/chan_theory_full.json") as f:
    chapters = json.load(f)

# Core theory chapters most relevant to stock screening
key_indices = [21, 22, 23, 25, 26, 29, 30, 32, 34, 37, 38, 40, 41, 42, 43, 48, 49, 58, 67, 72, 73, 78, 84, 96, 97, 98, 104, 106, 107, 108, 111, 113]

for k in key_indices:
    ch = chapters[k-1]  # 0-indexed
    print(f"\n{'='*80}")
    print(f"CHAPTER {ch['index']}")
    print(f"{'='*80}")
    # Get first 1000 chars as intro
    print(ch['content'][:2000])
    print(f"\n... [{len(ch['content'])} chars total] ...")
