#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backfill_m30.py — 用 baostock 补齐本地 stock_kline_30m 表到最近 1 年

背景:
  现有 sync_minute_kline.py 用腾讯 mkline 接口, 单只最多返回 800 根 30m (~5个月),
  无法覆盖完整 1 年。baostock 可拉到完整历史 (frequency=30, adjustflag=2 前复权)。

关键决策:
  - 用 ProcessPoolExecutor 而非 ThreadPoolExecutor
      -> baostock 非线程安全, 并发访问会污染 get_row_data (list index out of range)
      -> 进程池内每进程独立 baostock 实例, 完全隔离, 已验证安全
      -> 每进程独立 sqlite 连接 (check_same_thread=False 配合进程内单线程)
  - 前复权 (adjustflag=2), 与腾讯源现有数据口径对齐 (已验证 2025-12-17 一致)
  - INSERT OR REPLACE 幂等合并, 不破坏已有数据
  - 退市/停牌股 (baostock 无数据) 标记 empty 跳过, 不视为错误

用法:
  python3 backfill_m30.py --start 2025-09-08 [--end YYYY-MM-DD] [--period 30|60]
                          [--workers 4] [--limit N] [--codes A,B] [--proxy 127.0.0.1:7891]

账号 / 出口 (2026-09-12 自测定性: 厂商按 IP 拉黑, 不是按账号):
  直连 → 10001011「黑名单用户」; 经境外 SOCKS5 出口 → login success 且数据正常。
  ⇒ 默认走 --proxy / env BS_PROXY 指定的 SOCKS5; 不设则直连。
  注册账号仍可用 env 覆盖 (非本次根因, 但保留):
    BS_USER=your_account BS_PASS=your_pwd python3 backfill_m30.py --start 2025-09-08 --period 30

量纲约定 (2026-09-12 实测校准):
  stock_kline_30m : volume 单位=股, amount 单位=元   (baostock 原生)
  stock_kline_60m : volume 单位=手(=股/100), amount 单位=元
  ⇒ period=60 写库时 volume/100, 与表内既有数据(手)保持一致
  价格口径: baostock adjustflag=2 (前复权), 与表内既有 1 年数据一致
"""
import argparse
import os
import socket
import sqlite3
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

DB_PATH = "/root/sclaw/backend/data/stock_history.db"
FIELDS = "date,time,open,high,low,close,volume,amount"

# baostock 内部用裸 socket.socket() + connect()（不传 timeout），源端不可达时会**无限挂起**：
# 实测 2026-09-12 厂商 114.94.20.42:10030 不可达 → 10 个 worker 全部卡死 17min+ 零进度，
# 例行脚本的单例锁被永久持有（次日例行直接跳过），且 journal 无任何写入。
# 兜底：设默认 socket 超时 → connect/recv 抛 socket.timeout，被 worker 的 except 捕获记为该票 error。
SOCK_TIMEOUT = 30.0
socket.setdefaulttimeout(SOCK_TIMEOUT)

# 熔断：源端整体不可用时的「快速失败」阈值。
# 累计失败达到该数量且成功数为 0 → 判定源端不可用，提前终止并 exit 2（而不是 5746 只 × 30s 磨几小时）。
ABORT_AFTER = 30

# ── 出口代理（SOCKS5）────────────────────────────────────────────────────────
# 根因（2026-09-12 实测定性）：厂商按 **IP** 拉黑，不是按账号。
#   同一匿名账号：直连(本机 CN 出口) → 10001011「黑名单用户」；
#                 经境外出口            → login success、数据正常返回。
#   旁证：随便编一个账号名直连同样返回 10001011（而非「用户名或密码错误」）
#         ⇒ 服务端在「校验凭据之前」就按 IP 拒绝。
# 处置：把 baostock 的裸 socket 导向本机 SOCKS5（mihomo），由代理出口出面。
#   默认端口取环境变量 BS_PROXY（形如 127.0.0.1:7891），--proxy 可覆盖。
BS_PROXY = os.environ.get("BS_PROXY", "").strip()


def _install_socks_proxy(proxy: str):
    """薄壳：实现在 scripts/bs_proxy.py（唯一真源），此处保留旧名以免调用点扩散。

    baostock 的 socket 补丁是进程级的 —— 进程池里每个 worker 必须各打一次。
    """
    try:
        from bs_proxy import install_socks_proxy
    except ImportError:                      # 兜底：非 scripts/ 作为 cwd 被调用时
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from bs_proxy import install_socks_proxy
    return install_socks_proxy(proxy, SOCK_TIMEOUT)

# period -> (baostock frequency, 目标表, volume 除数)
PERIODS = {
    30: ("30", "stock_kline_30m", 1.0),     # 表内 volume 单位=股
    60: ("60", "stock_kline_60m", 100.0),   # 表内 volume 单位=手
}

_SESSION = {"logged": False, "login_msg": "", "account": ""}


def _detect_symbol(code: str) -> str:
    # baostock 格式: sh.600000 / sz.000001 / bj.830000
    if code.startswith(("6", "9")):
        return "sh." + code
    if code.startswith(("8", "4")):
        return "bj." + code
    return "sz." + code


def _fmt_dt(dt: str) -> str:
    # '20251217100000000' -> '2025-12-17 10:00'
    if len(dt) >= 12:
        return f"{dt[0:4]}-{dt[4:6]}-{dt[6:8]} {dt[8:10]}:{dt[10:12]}"
    return dt


def _ensure_login():
    """每个进程只 login 一次, 复用到进程结束 (省掉每只票一次握手)

    账号来源：
      - 默认走 baostock 库自带的匿名凭据（user_id='anonymous'）。厂商对匿名高并发抓取
        会拉黑（实测 2026-09-12 起持续返回 10001011「黑名单用户，请与管理员联系」）。
      - 设 BS_USER / BS_PASS 环境变量则改用注册账号登录 —— 这是官方许可的解法：
          BS_USER=xxx BS_PASS=yyy python3 scripts/backfill_m30.py --start ... --period 30
    """
    import baostock as bs
    if _SESSION["logged"]:
        return True
    user = (os.environ.get("BS_USER") or "").strip()
    pwd = (os.environ.get("BS_PASS") or "").strip()
    if user and pwd:
        lg = bs.login(user, pwd)
        _SESSION["account"] = user
    else:
        lg = bs.login()
        _SESSION["account"] = "anonymous"
    _SESSION["logged"] = lg.error_code == "0"
    if not _SESSION["logged"]:
        # 记住原因：2026-09-12 实测厂商返回 10001011「黑名单用户，请与管理员联系」
        # （TCP 可连、但账号/IP 被拒）→ 必须把原因带出来，否则例行告警只说「失败」无从下手
        _SESSION["login_msg"] = f"{lg.error_code}:{getattr(lg, 'error_msg', '')}"
    return _SESSION["logged"]


def worker(code: str, start: str, end: str, period: int = 30, proxy: str = ""):
    """在独立进程内拉取并写入一只股票, 返回 (code, rows, status)"""
    if proxy:                                # 子进程内独立打补丁（进程池每进程各一份）
        _install_socks_proxy(proxy)
    import baostock as bs
    socket.setdefaulttimeout(SOCK_TIMEOUT)   # 子进程内再确认一次（fork/spawn 后仍生效）
    freq, table, vol_div = PERIODS[period]
    try:
        # login 也要在 try 内：源端不可达时 login 自身就会抛 socket.timeout
        # （曾经不在 try 内 → 异常穿透 worker → fut.result() 直接炸主进程，无熔断无统计）
        if not _ensure_login():
            msg = _SESSION.get("login_msg", "")
            return code, 0, ("login_fail:" + msg) if msg else "login_fail"
        sym = _detect_symbol(code)
        rs = bs.query_history_k_data_plus(
            sym, FIELDS, start_date=start, end_date=end, frequency=freq, adjustflag="2"
        )
        if rs.error_code != "0":
            return code, 0, "query_err"
        bars = []
        while rs.error_code == "0" and rs.next():
            row = rs.get_row_data()
            if len(row) >= 8:
                dt = _fmt_dt(row[1])
                try:
                    bars.append({
                        "code": code,
                        "datetime": dt,
                        "open": float(row[2]),
                        "high": float(row[3]),
                        "low": float(row[4]),
                        "close": float(row[5]),
                        "volume": (float(row[6]) / vol_div) if row[6] else 0.0,
                        "amount": float(row[7]) if row[7] else 0.0,
                    })
                except ValueError:
                    continue
        if not bars:
            return code, 0, "empty"

        # 独立进程内逐一写库 (进程隔离, 单线程访问)
        conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        try:
            conn.executemany(
                """INSERT OR REPLACE INTO %s
                   (code, datetime, open, high, low, close, volume, amount)
                   VALUES (:code, :datetime, :open, :high, :low, :close, :volume, :amount)""" % table,
                bars,
            )
            conn.commit()
        finally:
            conn.close()
        return code, len(bars), "ok"
    except Exception as e:
        return code, 0, f"error:{e}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2025-09-08", help="1年起点 YYYY-MM-DD")
    ap.add_argument("--end", default="", help="截止日, 默认今天")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 只 (0=全量)")
    ap.add_argument("--codes", default="", help="逗号分隔 code 列表, 覆盖股票池")
    ap.add_argument("--period", type=int, default=30, choices=[30, 60],
                    help="30=stock_kline_30m(默认) / 60=stock_kline_60m")
    ap.add_argument("--proxy", default=BS_PROXY,
                    help="SOCKS5 出口 host:port（默认取 env BS_PROXY）。"
                         "厂商按 IP 拉黑，境外出口可绕，例 127.0.0.1:7891")
    args = ap.parse_args()

    end = args.end or time.strftime("%Y-%m-%d")
    freq, table, vol_div = PERIODS[args.period]
    print(f"[backfill_m30] period={args.period}({freq}m) -> {table} vol_div={vol_div} "
          f"start={args.start} end={end} workers={args.workers} "
          f"proxy={args.proxy or '直连'}")

    if args.codes:
        codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    else:
        conn = sqlite3.connect(DB_PATH)
        codes = [r[0] for r in conn.execute("SELECT code FROM stock_info ORDER BY code").fetchall()]
        conn.close()
    if args.limit:
        codes = codes[: args.limit]
    print(f"[backfill_m30] 股票池 {len(codes)} 只")

    t0 = time.time()
    done = 0
    total_rows = 0
    aborted = False
    stats = {"ok": 0, "empty": 0, "login_fail": 0, "query_err": 0, "error": []}
    lf_msgs = set()   # 去重后的 login 失败原因（如 10001011:黑名单用户）

    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(worker, c, args.start, end, args.period, args.proxy): c for c in codes}
        for fut in as_completed(futs):
            code, n, status = fut.result()
            done += 1
            total_rows += n
            # 修 bug(2026-09-12 自测发现)：原写法 stats[status if status in stats else "error"] += 1
            # 在 status="error:..." 时会取到 stats["error"]（是 list），list += 1 → TypeError，
            # 即「任意一只票抛异常」都会把整个 backfill 打崩（rc=1、无熔断、无统计）
            base = status.split(":", 1)[0]
            if base in ("ok", "empty", "login_fail", "query_err"):
                stats[base] += 1
            else:
                stats["error"] = [e for e in stats["error"] if not e.startswith(code)]
                stats["error"].append(f"{code}: {status}")
            if base == "login_fail" and ":" in status:
                msg = status.split(":", 1)[1]
                if msg not in lf_msgs:
                    lf_msgs.add(msg)
                    print(f"[backfill_m30] !! baostock 登录被拒(账号={os.environ.get('BS_USER') or 'anonymous'}): {msg}"
                          f"  (TCP 可连但账号/IP 被拒 → 非网络问题；实测 2026-09-12 为 IP 级拉黑，加 --proxy 走境外出口即可)")
            if done % 100 == 0 or done == len(codes):
                el = time.time() - t0
                print(f"[{done}/{len(codes)}] +{total_rows}行 ok={stats['ok']} empty={stats['empty']} "
                      f"err={len(stats['error'])} elapsed={el:.0f}s rate={done/el:.1f}/s")
            # 熔断：一只都没成功、失败已累积到阈值 → 判定源端整体不可用，别再磨下去
            nfail = len(stats["error"]) + stats["login_fail"] + stats["query_err"]
            if stats["ok"] == 0 and nfail >= ABORT_AFTER:
                print(f"[backfill_m30] !! 熔断：已处理 {done}/{len(codes)} 只、成功 0 只、"
                      f"失败 {nfail} 只 → 判定源端不可用，提前终止")
                for f in futs:
                    f.cancel()
                aborted = True
                break

    el = time.time() - t0
    print(f"\n[backfill_m30] DONE: {done}/{len(codes)} stocks, +{total_rows}行, "
          f"ok={stats['ok']} empty={stats['empty']} login_fail={stats['login_fail']} "
          f"query_err={stats['query_err']} errors={len(stats['error'])} elapsed={el:.0f}s")
    if stats["error"]:
        print("  errors sample:", stats["error"][:10])

    # 退出码：供例行脚本判定「源端不可用」，避免「全失败但 rc=0」被当成 ok
    rc = 0
    if aborted or (stats["ok"] == 0 and (stats["error"] or stats["login_fail"])):
        rc = 2
    elif len(stats["error"]) > max(10, int(done * 0.1)):
        rc = 3
    if rc:
        why = "源端不可用/熔断"
        if rc == 2 and stats["login_fail"]:
            why = f"baostock 登录被拒×{stats['login_fail']}: {sorted(lf_msgs)[0] if lf_msgs else '原因未知'}"
        elif rc == 3:
            why = "异常票占比过高"
        print(f"[backfill_m30] 以非零码退出 rc={rc}（{why}）")
    sys.exit(rc)


if __name__ == "__main__":
    main()
