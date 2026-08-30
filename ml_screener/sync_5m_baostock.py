#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync_5m_baostock.py — 用 baostock 把 stock_5m.db 的 5m 历史扩展到指定区间
用法: python3 sync_5m_baostock.py --start 2026-05-28 --end 2026-08-28 [--procs 10]
特性:
  - 多进程拉取 (每进程独立 baostock login — baostock 是全局单连接, 不能多线程共享!)
  - 主进程串行写库 (SQLite 安全), 批量 commit
  - INSERT OR REPLACE (按主键 code+datetime 去重)
  - 断点续传: progress 记录 {code: [start, end]}, 覆盖当前区间的跳过
  - datetime 格式转换: baostock '20260528093500000' -> '2026-05-28 09:35'
"""
import sqlite3, time, json, os, argparse
from multiprocessing import Process, Queue, JoinableQueue

DAILY_DB = '/root/sclaw/data/stock_history.db'
M5_DB = '/root/sclaw/data/stock_5m.db'
PROGRESS = '/root/sclaw/data/sync_5m_progress.json'

def tx_code(code):
    if code.startswith('6'):
        return 'sh.' + code
    if code.startswith(('0', '3')):
        return 'sz.' + code
    return None

def bs_to_dt(t):
    return f"{t[0:4]}-{t[4:6]}-{t[6:8]} {t[8:10]}:{t[10:12]}"

def get_all_codes():
    conn = sqlite3.connect(DAILY_DB)
    codes = [r[0] for r in conn.execute("SELECT DISTINCT code FROM stock_daily")]
    conn.close()
    return sorted(codes)

def load_progress():
    if os.path.exists(PROGRESS):
        with open(PROGRESS) as f:
            return json.load(f)
    return {}

def save_progress(p):
    tmp = PROGRESS + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(p, f)
    os.replace(tmp, PROGRESS)

def worker_proc(q_in, q_out, start, end, worker_id):
    """子进程: 独立 import baostock + login, 从队列拿 code 拉取, 结果放队列"""
    import baostock as bs
    import time as _t
    _t.sleep(worker_id * 2)  # 错开登录, 避免并发冲击
    lg = bs.login()
    if lg.error_code != '0':
        q_out.put(('FATAL', worker_id, lg.error_msg))
        return
    while True:
        item = q_in.get()
        if item is None:
            break
        code = item
        bs_code = tx_code(code)
        if bs_code is None:
            q_out.put((code, None, None))
            continue
        try:
            rs = bs.query_history_k_data_plus(
                bs_code, "date,time,code,open,high,low,close,volume,amount",
                start_date=start, end_date=end, frequency="5", adjustflag="3")
            rows = []
            while rs.next():
                r = rs.get_row_data()
                if len(r) < 9:
                    continue
                rows.append((code, bs_to_dt(r[1]), float(r[3]), float(r[4]),
                             float(r[5]), float(r[6]), float(r[7]), float(r[8])))
            q_out.put((code, rows, None))
        except Exception as e:
            q_out.put((code, None, f"ERR {e}"))
    bs.logout()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--start', required=True)
    ap.add_argument('--end', required=True)
    ap.add_argument('--procs', type=int, default=10)
    args = ap.parse_args()
    start, end = args.start, args.end

    codes = get_all_codes()
    progress = load_progress()
    def covered(c):
        r = progress.get(c)
        return r and r[0] == start and r[1] == end
    todo = [c for c in codes if not covered(c)]
    print(f"全市场 {len(codes)} 只, 已覆盖区间 {len(codes)-len(todo)}, 待拉 {len(todo)}", flush=True)
    print(f"区间: {start} ~ {end}, 进程: {args.procs}", flush=True)

    conn = sqlite3.connect(M5_DB)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")

    q_in = JoinableQueue(maxsize=args.procs * 4)
    q_out = Queue()
    procs = []
    for i in range(args.procs):
        p = Process(target=worker_proc, args=(q_in, q_out, start, end, i), daemon=True)
        p.start()
        procs.append(p)

    # 预填队列
    for c in todo:
        q_in.put(c)

    n_written, n_fail, n_none = 0, 0, 0
    t_start = time.time()
    done_count = 0
    total = len(todo)

    # 主进程收集结果 + 写库 (串行, SQLite 安全)
    while done_count < total:
        code, rows, err = q_out.get()
        done_count += 1
        if rows is None and err is None:
            n_none += 1
        elif err:
            n_fail += 1
            print(f"[{done_count}/{total}] {code} FAIL {err}", flush=True)
        elif rows:
            conn.executemany(
                "INSERT OR REPLACE INTO stock_kline_5m"
                "(code,datetime,open,high,low,close,volume,amount) VALUES (?,?,?,?,?,?,?,?)",
                rows)
            n_written += len(rows)
        progress[code] = [start, end]
        if done_count % 50 == 0:
            save_progress(progress)
        if done_count % 200 == 0 or done_count == total:
            el = time.time() - t_start
            print(f"[{done_count}/{total}] {el:.0f}s ({done_count/el:.1f}只/s) "
                  f"写入{n_written:,}行 失败{n_fail} 无数据{n_none}", flush=True)
            conn.commit()

    # 停止子进程
    for _ in range(args.procs):
        q_in.put(None)
    for p in procs:
        p.join(timeout=5)

    save_progress(progress)
    conn.commit()
    conn.close()
    el = time.time() - t_start
    print(f"完成! 总耗时 {el:.0f}s ({el/60:.1f}min), 写入 {n_written:,} 行, "
          f"失败 {n_fail}, 无数据 {n_none}", flush=True)

if __name__ == '__main__':
    main()
