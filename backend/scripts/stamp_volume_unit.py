#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给三个 clean 库盖「成交量口径=手」的戳（记录 2026-09-12 的归一化迁移）。

- clean_daily.db 原本没有 meta 表 → 建
- clean_m30.db / clean_m60.db 有 meta → 追加/覆盖 volume_* 键
只写 5 行不到的 meta 键，不动任何业务行。
"""
import sqlite3
import time

BASES = {
    "clean_daily": "/root/sclaw/backend/data/clean_daily.db",
    "clean_m30": "/root/sclaw/backend/data/clean_m30.db",
    "clean_m60": "/root/sclaw/backend/data/clean_m60.db",
}
NOTE = ("2026-09-12 归一化到「手」: clean_daily 688/689 ÷100 (722970 行); "
        "clean_m30 全表 ÷100 (9687527 行); clean_m60 原样(源已是手). "
        "自证(2026-09-11): 5199 只 daily/m30 = m60/m30 = 1.0000")

for name, path in BASES.items():
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    rows = [
        ("volume_unit", "手"),
        ("volume_unit_note", NOTE),
        ("volume_normalized_at", now),
    ]
    if name == "clean_daily":
        rows.append(("volume_src_div", "科创板(688/689)=100, 其他=1"))
    elif name == "clean_m30":
        rows.append(("volume_src_div", "100 (源 stock_kline_30m volume=股)"))
    else:
        rows.append(("volume_src_div", "1 (源 stock_kline_60m volume=手)"))
    c.executemany("insert or replace into meta values (?,?)", rows)
    c.commit()
    got = dict(c.execute("select key, value from meta"))
    print("[%s] volume_unit=%s  normalized_at=%s" % (name, got.get("volume_unit"), got.get("volume_normalized_at")))
    c.close()
print("[OK] 三个库口径戳已写入")
