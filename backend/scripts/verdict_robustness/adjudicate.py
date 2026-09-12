#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Adjudicate the 17 impossible days found in clean_daily.db (v2).

For each (code, date): dump the +/-4 bar neighbourhood from v2 AND from the
rollback lib, plus the implied event ratio (1/ratio = implied 送转 multiplier).

Discriminators:
  - qfq must be CONTINUOUS across an ex-date. An isolated jump whose 1/ratio
    matches a plausible 送转 ratio (2.0=10送10, 3.0=10送20, 5.5=10送45 ...)
    => missed adjustment factor => DEFECT (mask).
  - A jump on a first-ever bar, or on a resume-from-halt with huge volume,
    and NOT reproducible in the old lib => institutional FACT (keep).
"""
import sqlite3

V2 = '/root/sclaw/backend/data/clean_daily.db'
OLD = '/root/sclaw/backend/data/clean_daily.db.bak1789216383'

EVENTS = [
    ('000038', '2023-06-19'), ('600462', '2025-06-24'), ('002751', '2023-06-20'),
    ('300089', '2023-06-20'), ('300208', '2025-06-30'), ('600275', '2022-05-25'),
    ('300742', '2024-07-01'), ('300038', '2022-06-09'), ('600896', '2022-06-28'),
    ('301563', '2025-10-09'), ('688535', '2023-04-06'), ('688256', '2020-07-21'),
    ('688661', '2021-03-30'), ('301166', '2021-12-29'), ('001221', '2025-07-31'),
    ('603124', '2025-03-21'), ('688173', '2022-01-24'),
]

def ro(p):
    return sqlite3.connect('file:%s?mode=ro' % p, uri=True)

v2, old = ro(V2), ro(OLD)

def window(con, code, date, k=4):
    rows = con.execute(
        'select date, open, high, low, close, volume from daily '
        'where code=? order by date', (code,)).fetchall()
    idx = None
    for i, r in enumerate(rows):
        if r[0] == date:
            idx = i
            break
    if idx is None:
        return None, None
    lo = max(0, idx - k)
    hi = min(len(rows), idx + k + 1)
    return rows[lo:hi], idx - lo

for code, date in EVENTS:
    w, pos = window(v2, code, date)
    print('=' * 78)
    if w is None:
        print('%s %s : NOT IN V2' % (code, date))
        continue
    ev = w[pos]
    if pos > 0:
        prev_close = w[pos - 1][4]
        ratio = ev[4] / prev_close if prev_close else 0
        inv = (1.0 / ratio) if ratio else 0
        print('%s  %s   prev=%.4f -> close=%.4f   ret=%.2f%%   implied 送转 mult=%.3f'
              % (code, date, prev_close, ev[4], (ratio - 1) * 100, inv))
    else:
        print('%s  %s   (first bar in v2)  close=%.4f' % (code, date, ev[4]))
    print('  first bar of window: %s   bars=%d' % (w[0][0], len(w)))
    print('  V2   date         open      high      low       close      volume')
    for i, r in enumerate(w):
        mark = ' <== EVENT' if i == pos else ''
        print('       %s  %9.4f %9.4f %9.4f %9.4f  %12.0f%s'
              % (r[0], r[1], r[2], r[3], r[4], r[5], mark))
    wo, poso = window(old, code, date, k=4)
    if wo is None:
        print('  OLD  : event date not present in rollback lib')
    else:
        print('  OLD  date         open      high      low       close      volume')
        for i, r in enumerate(wo):
            mark = ' <== EVENT' if i == poso else ''
            print('       %s  %9.4f %9.4f %9.4f %9.4f  %12.0f%s'
                  % (r[0], r[1], r[2], r[3], r[4], r[5], mark))
