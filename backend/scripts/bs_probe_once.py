#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单次 baostock 探测（一次 login + 一次小查询），供复现「直连 vs 代理」与退避策略。
   用法: BS_PROXY=127.0.0.1:17890 python3 bs_probe_once.py <tag>
"""
import os
import sys
import time

sys.path.insert(0, "/root/sclaw/backend/scripts")

tag = sys.argv[1] if len(sys.argv) > 1 else "?"
proxy = (os.environ.get("BS_PROXY") or "").strip()

import baostock as bs

if proxy:
    from bs_proxy import install_socks_proxy
    install_socks_proxy(proxy, timeout=30)

t0 = time.time()
try:
    lg = bs.login()
except Exception as e:
    print("%-34s EXC %s: %s" % (tag, type(e).__name__, e))
    sys.exit(0)
dt = time.time() - t0
code, msg = lg.error_code, lg.error_msg
if code != "0":
    print("%-34s LOGIN_FAIL %s %s (%.1fs)" % (tag, code, msg, dt))
    sys.exit(0)

rs = bs.query_history_k_data_plus(
    "sh.600000", "date,close,turn,volume",
    start_date="2026-09-10", end_date="2026-09-11", frequency="d", adjustflag="2",
)
rows = []
while rs.next():
    rows.append(rs.get_row_data())
print("%-34s OK login=%.1fs rc=%s rows=%s" % (tag, dt, rs.error_code, rows))
bs.logout()
