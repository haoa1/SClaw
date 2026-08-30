#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
data_loader.py — 5分钟K线回测数据加载器 (stock_5m.db)
========================================================
为回测引擎提供两种视角:
  1. load(code, start, end)  -> 单股 OHLCV DataFrame (行=datetime)
  2. day(date)               -> 全市场某日宽表 (行=48个bar, 列=5200+股票)
                               返回 dict{o/h/l/c/v: DataFrame}  —— 逐bar扫描策略友好
  3. days(start, end)        -> 逐交易日迭代器, yield (date, day(date)宽表)
  4. trading_days(start,end) -> 交易日列表

数据源: 腾讯 ifzq m5, 每只最多800根(~16交易日), 每日收盘后 cron 刷新窗口。

用法:
  from data_loader import FiveMinLoader
  ld = FiveMinLoader()
  df  = ld.load('000012')                    # 单股全窗口
  d   = ld.day('2026-08-26')                 # 全市场某日
  for date, w in ld.days('2026-08-24', '2026-08-26'):
      ...                                    # 逐日回放
"""
import sqlite3

import pandas as pd

DEFAULT_DB = "/root/sclaw/data/stock_5m.db"
COLS = ("open", "high", "low", "close", "volume", "amount")
# 每交易日 bar 数 (A股 4小时 = 48 根 5min bar; 含集合竞价 09:30 起)
BARS_PER_DAY = 48


class FiveMinLoader:
    def __init__(self, db: str = DEFAULT_DB):
        self.db = db
        self._conn = sqlite3.connect(db, timeout=30)

    # ---------- 基础 ----------
    def codes(self) -> list:
        return [r[0] for r in self._conn.execute(
            "SELECT DISTINCT code FROM stock_kline_5m ORDER BY code")]

    def trading_days(self, start: str = None, end: str = None) -> list:
        sql = "SELECT DISTINCT substr(datetime,1,10) d FROM stock_kline_5m"
        if start or end:
            sql += " WHERE " + " AND ".join(
                f"substr(datetime,1,10) {op} '{v}'"
                for op, v in ((">=", start) if start else (), ("<=", end) if end else ()))
        sql += " ORDER BY d"
        return [r[0] for r in self._conn.execute(sql)]

    # ---------- 1. 单股 ----------
    def load(self, code: str, start: str = None, end: str = None) -> pd.DataFrame:
        sql = "SELECT datetime,open,high,low,close,volume,amount FROM stock_kline_5m WHERE code=?"
        args = [code]
        if start or end:
            sql += " AND " + " AND ".join(
                f"datetime {op} ?" for op in ((">=", start + " 00:00") if start else (), ("<=", end + " 23:59") if end else ()))
            args += [a for a in ((start + " 00:00") if start else (), (end + " 23:59") if end else ())]
        df = pd.read_sql_query(sql, self._conn, params=args, parse_dates=["datetime"])
        if df.empty:
            return df
        return df.set_index("datetime").sort_index()

    # ---------- 2. 全市场某日宽表 ----------
    def day(self, date: str) -> dict:
        """返回 {open,high,low,close,volume: DataFrame}, index=bar时间(48), columns=股票代码"""
        df = pd.read_sql_query(
            "SELECT datetime,code,open,high,low,close,volume FROM stock_kline_5m "
            "WHERE substr(datetime,1,10)=? ORDER BY datetime",
            self._conn, params=(date,))
        if df.empty:
            return {c: pd.DataFrame() for c in COLS[:5]}
        df["datetime"] = df["datetime"].str[11:16]  # 只留 HH:MM
        out = {}
        for c in COLS[:5]:
            out[c] = df.pivot_table(index="datetime", columns="code", values=c, aggfunc="first")
        return out

    # ---------- 3. 逐日迭代 ----------
    def days(self, start: str = None, end: str = None):
        for d in self.trading_days(start, end):
            yield d, self.day(d)

    # ---------- 工具 ----------
    def close_rows(self, date: str) -> pd.DataFrame:
        """当日所有股票收盘价 Series (code -> close), 常用于日终估值"""
        df = pd.read_sql_query(
            "SELECT code,close FROM stock_kline_5m WHERE substr(datetime,1,10)=? AND substr(datetime,12,5)='15:00'",
            self._conn, params=(date,))
        return df.set_index("code")["close"] if not df.empty else pd.Series(dtype=float)

    def close(self):
        self._conn.close()


if __name__ == "__main__":
    import sys
    ld = FiveMinLoader()
    print(f"交易日数: {len(ld.trading_days())}, 最早 {ld.trading_days()[0]} 最晚 {ld.trading_days()[-1]}")
    print(f"股票数: {len(ld.codes())}")
    if len(sys.argv) > 1:
        day = sys.argv[1]
    else:
        day = ld.trading_days()[-1]
    d = ld.day(day)
    print(f"\n== 全市场 {day} 宽表 ==")
    for c in ("open", "close", "volume"):
        df = d[c]
        print(f"  {c}: {df.shape}  行={df.index[0]}~{df.index[-1]}, 列样本={list(df.columns[:3])}...")
    df = ld.load("000012")
    print(f"\n单股 000012: {df.shape}  {df.index[0]} ~ {df.index[-1]}")
    print(df.tail(2))
    ld.close()
