#!/usr/bin/env python3
"""
v2 OHLC bracket-consistency audit (read-only).

Purpose: decide whether the Python eval framework can read v2's OHLC directly
instead of rebuilding an adjusted series from change_pct.

Key idea:
  v2's adjustment is multiplicative with a PER-STOCK factor (a step function
  applied across the whole series). If it was applied uniformly to O/H/L/C,
  then for every row:  low <= min(open, close)  and  max(open, close) <= high.
  If someone adjusted CLOSE ONLY, close would escape [low, high] after the
  change -> we would see violations concentrated on split/dividend dates.

Also sanity-checks volume unit (手) and amount unit (元) via amount / shares.
"""
import sqlite3
import sys

DB = "/root/sclaw/backend/data/clean_daily.db"

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = con.cursor()

cur.execute("SELECT COUNT(*) FROM daily")
total = cur.fetchone()[0]
print(f"rows total            : {total:,}")

# --- 1. bracket consistency O/H/L/C -----------------------------------------
cur.execute("""
    SELECT COUNT(*) FROM daily
    WHERE high IS NOT NULL AND low IS NOT NULL AND open IS NOT NULL AND close IS NOT NULL
      AND (high < low
        OR close > high + 1e-6
        OR close < low  - 1e-6
        OR open  > high + 1e-6
        OR open  < low  - 1e-6)
""")
bad = cur.fetchone()[0]
print(f"OHLC bracket viol (abs): {bad:,}")
if total:
    print(f"OHLC bracket viol (pct): {100.0 * bad / total:.6f}%")

# --- 2. how bad are the violations (magnitude) ------------------------------
cur.execute("""
    SELECT COUNT(*) FROM daily
    WHERE high < low OR close > high * 1.0001 OR close < low * 0.9999
""")
gross = cur.fetchone()[0]
print(f"gross viol >0.01pct    : {gross:,}")

# --- 3. zero / null / negative price guard ----------------------------------
cur.execute("""
    SELECT COUNT(*) FROM daily
    WHERE close IS NULL OR close <= 0 OR open <= 0 OR high <= 0 OR low <= 0
""")
nonpos = cur.fetchone()[0]
print(f"nonpositive prices     : {nonpos:,}")

# --- 4. intraday amplitude sanity -------------------------------------------
cur.execute("SELECT AVG((high - low) / close), MAX((high - low) / close) FROM daily WHERE close > 0")
avg_amp, max_amp = cur.fetchone()
print(f"mean (high-low)/close  : {avg_amp:.5f}")
print(f"max  (high-low)/close  : {max_amp:.5f}")

# --- 5. volume / amount units ------------------------------------------------
# amount (元) / (volume 手 * 100) should be a stock price, not a wild number.
cur.execute("""
    SELECT AVG(amount / (volume * 100.0)), MIN(amount / (volume * 100.0)),
           MAX(amount / (volume * 100.0))
    FROM daily
    WHERE volume > 0 AND amount > 0 AND close > 0
      AND amount / (volume * 100.0) BETWEEN 0.1 AND 5000
""")
a, mn, mx = cur.fetchone()
print(f"implied VWAP mean      : {a:.3f}" if a else "implied VWAP mean      : n/a")
print(f"implied VWAP min       : {mn:.3f}" if mn else "implied VWAP min       : n/a")
print(f"implied VWAP max       : {mx:.3f}" if mx else "implied VWAP max       : n/a")

cur.execute("""
    SELECT COUNT(*) FROM daily
    WHERE volume > 0 AND amount > 0
      AND (amount / (volume * 100.0) < 0.1 OR amount / (volume * 100.0) > 5000)
""")
outl = cur.fetchone()[0]
print(f"VWAP outliers          : {outl:,}")

# --- 6. turnover rate band ---------------------------------------------------
cur.execute("SELECT MIN(turn), AVG(turn), MAX(turn) FROM daily WHERE turn IS NOT NULL")
t0, t1, t2 = cur.fetchone()
print(f"turn min/avg/max       : {t0} / {t1:.3f} / {t2}")

con.close()
