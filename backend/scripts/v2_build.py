#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""clean_daily v2 全量重建（混合架构，可续传）

  qfq_OHLC  = 腾讯 raw OHLC × baostock foreAdjustFactor(阶梯函数)   ← 已实证 1624 日零偏差
  volume/amount/turn = 继承生产库（不受复权缺陷影响，09-12 已校验）

用法: python3 v2_build.py [--beg 2015-01-01] [--end 2026-09-11] [--limit N]
"""
import os
import sys
import time
import sqlite3
import threading
import argparse
import traceback

sys.path.insert(0, '/root/sclaw/backend/scripts')
sys.path.insert(0, '/tmp')
from bs_proxy import install_socks_proxy, proxy_from_env   # noqa: E402
# ★ 只有 baostock 需要绕境外出口（境内 IP 被它拉黑）。
#   腾讯行情是境内 API —— 若也走代理，多一个出境 RTT，实测拖慢数倍。
install_socks_proxy(proxy_from_env('127.0.0.1:17890'),
                    only_hosts=['public-api.baostock.com'])
import baostock as bs          # noqa: E402
from tx_kline import fetch as tx_fetch   # noqa: E402

PROD = '/root/sclaw/backend/data/clean_daily.db'
V2 = '/root/sclaw/backend/data/clean_daily_v2.db'

# baostock 大 payload 查询会随机挂死 → 用「无进展 N 秒即自杀」让 shell 重启续传
_last = [time.time()]
STALL_SEC = 90
MAX_TRIES = 3

# ★ baostock 会话会在跑批途中失效：错误码 10001001「用户未登录」。
#   原版只在开头 login 一次 → 一旦掉线，后面每只股都失败，而且会把「基础设施故障」
#   记成「这只股的失败」，3 轮后被打成 failed_3x 永久丢出宇宙（静默数据缺失）。
#   所以：定期主动重登 + 遇错重登重试 + 基础设施错误不计入 tries + 熔断。
LOGIN_TTL = 240
INFRA_MARK = ('10001001', '用户未登录', '10001011', '黑名单', 'SSLEOFError',
              'URLError', 'timed out', 'timeout', 'Connection',
              'RemoteDisconnected', 'ProtocolError')
_login = {'ts': 0.0}


def is_infra(e):
    s = repr(e)
    return any(m in s for m in INFRA_MARK)


def ensure_login(force=False, tag=''):
    """登录/续登。返回 True 表示当前会话可用。"""
    now = time.time()
    if not force and _login['ts'] and now - _login['ts'] < LOGIN_TTL:
        return True
    try:
        bs.logout()
    except Exception:
        pass
    lg = bs.login()
    if lg.error_code != '0':
        sys.stderr.write('RELOGIN FAIL [%s] %s %s\n'
                         % (tag, lg.error_code, lg.error_msg))
        sys.stderr.flush()
        _login['ts'] = 0.0
        return False
    _login['ts'] = time.time()
    sys.stderr.write('LOGIN ok [%s]\n' % (tag or 'init'))
    sys.stderr.flush()
    return True


def tick():
    _last[0] = time.time()


def _watchdog():
    while True:
        time.sleep(10)
        if time.time() - _last[0] > STALL_SEC:
            sys.stderr.write('WATCHDOG: no progress %ds -> exit(9)\n' % STALL_SEC)
            sys.stderr.flush()
            os._exit(9)


DDL = [
    "create table if not exists daily(code text, date text, open real, high real,"
    " low real, close real, volume real, amount real, turn real,"
    " primary key(code,date))",
    "create table if not exists meta(key text primary key, value text)",
    "create table if not exists done(code text primary key, n integer, flag text, ts text)",
    "create table if not exists flag(code text primary key, first_factor_date text,"
    " n_pre integer, n_rows integer)",
    # ★ 重试计数：某只股若反复失败/反复触发看门狗，不能让它把驱动器永远卡在重试上
    "create table if not exists tries(code text primary key, n integer, last text)",
]


def bs_code(c):
    return ('sh.' if c[0] == '6' else 'sz.') + c


def tx_code(c):
    return ('sh' if c[0] == '6' else 'sz') + c


def get_factors(code, end):
    """[(除权日, foreAdjustFactor)] 升序。查询起点 1990 → 确保拿到「全部」历史除权日，
    这样窗口内任意 d 都能落到某个除权日之后（否则早期 d 会取不到因子）。"""
    for attempt in (1, 2, 3):
        try:
            ensure_login()
            ra = bs.query_adjust_factor(code=bs_code(code), start_date='1990-01-01',
                                        end_date=end)
            if ra.error_code != '0':
                raise RuntimeError('bs %s %s' % (ra.error_code, ra.error_msg))
            out = []
            while ra.next():
                r = ra.get_row_data()
                out.append((r[1], float(r[2])))
            out.sort()
            return out
        except Exception as e:
            if attempt == 3:
                raise
            tick()
            if is_infra(e):
                # ★ 会话掉了 → 立刻重登，而不是原样重试（原样重试必然再失败）
                ensure_login(force=True, tag='retry')
            time.sleep(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--beg', default='2015-01-01')
    ap.add_argument('--end', default='2026-09-11')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--codes', default='')       # 逗号分隔，仅重建指定代码（用于抽样校验）
    ap.add_argument('--db', default=V2)
    a = ap.parse_args()

    threading.Thread(target=_watchdog, daemon=True).start()

    prod = sqlite3.connect('file:%s?mode=ro' % PROD, uri=True)
    codes = [r[0] for r in prod.execute('select distinct code from daily order by code')]
    if a.codes:
        want = set(x.strip() for x in a.codes.split(',') if x.strip())
        codes = [c for c in codes if c in want]
    elif a.limit:
        codes = codes[:a.limit]

    con = sqlite3.connect(a.db)
    for stmt in DDL:
        con.execute(stmt)
    con.execute("insert or replace into meta values('beg',?)", (a.beg,))
    con.execute("insert or replace into meta values('end',?)", (a.end,))
    con.execute("insert or replace into meta values('method',?)",
                ('tencent_raw_x_baostock_foreAdjustFactor',))
    con.commit()

    finished = set(r[0] for r in con.execute('select code from done'))
    # ★ 超过重试上限的股不再排队（否则驱动器会在同一只股上无限重启）
    tries = dict(con.execute('select code, n from tries'))
    gaveup = [c for c in codes if tries.get(c, 0) >= MAX_TRIES and c not in finished]
    for c in gaveup:
        con.execute("insert or replace into done values(?,?,?,datetime('now'))",
                    (c, 0, 'gaveup_%dx' % MAX_TRIES))
    if gaveup:
        con.commit()
        finished |= set(gaveup)
        print('GAVEUP(carried) %d 只: %s' % (len(gaveup), ','.join(gaveup[:20])), flush=True)
    todo = [c for c in codes if c not in finished]
    print('universe=%d  finished=%d  todo=%d' % (len(codes), len(finished), len(todo)),
          flush=True)

    if not ensure_login(force=True, tag='pass-start'):
        print('LOGIN FAIL at pass start -> abort this pass (driver will retry)', flush=True)
        return 2

    t0 = time.time()
    ok = 0
    fail = 0
    flagged = 0
    infra = 0
    consec_infra = 0
    for i, code in enumerate(todo, 1):
        tick()
        try:
            rows = prod.execute(
                'select date,volume,amount,turn from daily where code=?'
                ' and date>=? and date<=? order by date', (code, a.beg, a.end)).fetchall()
            if not rows:
                con.execute("insert or replace into done values(?,?,?,datetime('now'))",
                            (code, 0, 'no_prod_rows'))
                con.commit()
                continue

            tx = tx_fetch(tx_code(code), 'day', a.beg, a.end)
            if not tx:
                raise RuntimeError('tencent empty')

            facs = get_factors(code, a.end)
            first_fac = facs[0][0] if facs else None

            out = []
            n_pre = 0
            miss = 0
            j = 0
            # ★ 因子是「阶梯函数」，必须跨行保持；不能每行重置 f=1.0
            f = facs[0][1] if facs else 1.0
            for d, vol, amt, trn in rows:
                k = tx.get(d)
                if not k:
                    miss += 1
                    continue
                # 腾讯字段序: [date, open, close, high, low, volume, ...]
                o, c, h, l = float(k[1]), float(k[2]), float(k[3]), float(k[4])
                if j == 0 and facs and d < facs[0][0]:
                    # d 早于该股首个除权日：foreAdjustFactor 只含「严格晚于」事件，
                    # 缺 ratio(T1) 无法从 F 本身反推 → 取 F(T1) 并计为 pre 标记
                    n_pre += 1
                while j < len(facs) and facs[j][0] <= d:
                    f = facs[j][1]
                    j += 1
                out.append((code, d, o * f, h * f, l * f, c * f, vol, amt, trn))

            con.executemany('insert or replace into daily values(?,?,?,?,?,?,?,?,?)', out)
            con.execute("insert or replace into done values(?,?,?,datetime('now'))",
                        (code, len(out), 'ok'))
            if n_pre:
                con.execute('insert or replace into flag values(?,?,?,?)',
                            (code, first_fac, n_pre, len(out)))
                flagged += 1
            con.commit()
            ok += 1
            if miss:
                sys.stderr.write('  %s tx_miss=%d\n' % (code, miss))
        except Exception as e:
            con.rollback()
            if is_infra(e):
                # ★ 基础设施故障（会话掉线 / 被墙 / 超时）不是这只股的错：
                #   绝不能计入 tries —— 否则 3 轮之后它会被打成 failed_3x 永久丢出宇宙，
                #   那就是「静默数据缺失」，比慢更可怕。
                infra += 1
                consec_infra += 1
                sys.stderr.write('  INFRA(%d, consec=%d) %s %r\n'
                                 % (infra, consec_infra, code, e))
                sys.stderr.flush()
                if consec_infra >= 12:
                    sys.stderr.write('  CIRCUIT BREAK: 连续 %d 次基础设施失败 -> 结束本轮(8)，'
                                     '由驱动器重登后重来\n' % consec_infra)
                    sys.stderr.flush()
                    con.commit()
                    return 8
                continue
            consec_infra = 0
            fail += 1
            tn = tries.get(code, 0) + 1
            tries[code] = tn
            con.execute('insert or replace into tries values(?,?,?)',
                        (code, tn, repr(e)[:300]))
            if tn >= MAX_TRIES:
                # 连续 N 次失败 → 标记 gaveup，下一轮不再排队（另外落状态，便于人工复核）
                con.execute("insert or replace into done values(?,?,?,datetime('now'))",
                            (code, 0, 'failed_%dx' % tn))
            con.commit()
            sys.stderr.write('  FAIL(%d/%d) %s %r\n' % (tn, MAX_TRIES, code, e))
            traceback.print_exc(file=sys.stderr)

        if i % 25 == 0 or i == len(todo):
            el = time.time() - t0
            rate = el / i
            print('  %d/%d  ok=%d fail=%d infra=%d flagged=%d  %.2fs/只  ETA=%.1fmin'
                  % (i, len(todo), ok, fail, infra, flagged, rate,
                     rate * (len(todo) - i) / 60), flush=True)

    bs.logout()
    print('PASS DONE ok=%d fail=%d flagged=%d  elapsed=%.1fmin'
          % (ok, fail, flagged, (time.time() - t0) / 60), flush=True)
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
