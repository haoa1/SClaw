#!/usr/bin/env python3
"""统计 Garuda 会话历史里「一次模型回复携带几个 tool_call」的分布。

目的：判断「工具并发执行」值不值得做 —— 如果绝大多数批次 N==1，并发毫无意义。
"""
import json, glob, os, collections

DATA = "/root/.garuda/sessions/data"
buckets = collections.Counter()          # N -> 批次数
name_pairs = collections.Counter()       # 同批内工具名组合
batch_names = collections.Counter()      # 出现在同一批里的工具名
detail = []                              # (n, [names])

files = sorted(glob.glob(os.path.join(DATA, "*.jsonl")))
scanned_msgs = 0
tool_msgs = 0

for fp in files:
    try:
        with open(fp, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                # 兼容两种结构：{"messages":[...]} 或直接一条消息
                msgs = obj.get("messages") if isinstance(obj, dict) and "messages" in obj else [obj]
                if not isinstance(msgs, list):
                    continue
                for m in msgs:
                    if not isinstance(m, dict):
                        continue
                    scanned_msgs += 1
                    if m.get("role") != "assistant":
                        continue
                    tcs = m.get("tool_calls") or []
                    if not tcs:
                        continue
                    tool_msgs += 1
                    names = []
                    for tc in tcs:
                        fn = (tc.get("function") or {}).get("name") or "?"
                        names.append(fn)
                    n = len(names)
                    buckets[n] += 1
                    batch_names.update(names)
                    if n > 1:
                        name_pairs[tuple(sorted(names))] += 1
                        detail.append((n, names, os.path.basename(fp)))
    except Exception as e:
        print(f"!! {fp}: {e}")

print("=" * 66)
print(f"扫描会话文件: {len(files)}   消息数: {scanned_msgs}   含工具调用的回复: {tool_msgs}")
print("=" * 66)
total_batches = sum(buckets.values()) or 1
multi = sum(v for k, v in buckets.items() if k > 1)
print(f"\n【批次大小分布】N = 单次回复里的 tool_call 个数")
for n in sorted(buckets):
    v = buckets[n]
    print(f"  N={n:>2}  {v:>5} 批  {v/total_batches*100:>5.1f}%  {'#' * min(60, int(v/total_batches*60))}")
print(f"\n  批次总数: {total_batches}")
print(f"  可并发机会 (N>=2): {multi} 批 = {multi/total_batches*100:.1f}%")
par = sum((n - 1) * v for n, v in buckets.items())
print(f"  串行总步数: {total_batches}  →  理想并发步数: {total_batches - par}   [省掉 {par} 次等待 = {par/total_batches*100:.1f}%]")

print(f"\n【同批出现的工具 TOP15】")
for name, c in batch_names.most_common(15):
    print(f"  {name:<22} {c}")

print(f"\n【多工具组合 TOP12】")
for combo, c in name_pairs.most_common(12):
    print(f"  {c:>4}x  {' + '.join(combo)}")
