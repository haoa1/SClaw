# -*- coding: utf-8 -*-
"""超跌买点 alpha 检验 —— 匹配基准 + 随机基线 + 样本外"""
import sqlite3
import numpy as np
import pandas as pd

DB = 'file:/root/sclaw/backend/data/stock_history.db?mode=ro'
WARM = 20

con = sqlite3.connect(DB, uri=True)
df = pd.read_sql(
    "select code, date, open, high, low, close, volume from stock_daily "
    "where date>='2021-01-01' order by code, date", con)
print('loaded', len(df), 'rows', df.code.nunique(), 'codes')

# 只保留沪深主板/中小/创业/科创；剔除北交所(4/8开头)、B股(9开头)
df = df[~df['code'].str[0].isin(['4', '8', '9'])].copy()
df = df[df['close'] > 0]
print('after board filter', len(df), df.code.nunique(), 'codes')

cw = df.pivot(index='date', columns='code', values='close').sort_index()
ow = df.pivot(index='date', columns='code', values='open').sort_index()
hw = df.pivot(index='date', columns='code', values='high').sort_index()
lw = df.pivot(index='date', columns='code', values='low').sort_index()
vw = df.pivot(index='date', columns='code', values='volume').sort_index()
dates = cw.index.to_numpy()
print('matrix', cw.shape)

ret20 = cw / cw.shift(20) - 1.0
ret60 = cw / cw.shift(60) - 1.0
ma20 = cw.rolling(20).mean()
dev20 = cw / ma20 - 1.0
vma5 = vw.rolling(5).mean()
vr = vw / vma5

# 成交额（volume 单位: 手 -> 股 x100）
amt = vw * cw * 100.0
amt20 = amt.rolling(20).mean()

valid = cw.notna() & ow.notna() & (cw > 1.0) & (amt20 >= 5e7)   # >1元, 20日均额>5000万

H_LIST = [5, 10, 20]
X_LIST = [0.10, 0.15, 0.20, 0.25]

# 入场 open[t+1]，出场 close[t+1+H]
entry = ow.shift(-1)
def fwd_close(H):
    return cw.shift(-(1 + H))

results = []

def run(mask, label, H):
    fwd = fwd_close(H)
    e = entry.where(mask & valid)
    x = fwd.where(mask & valid)
    r = (x / e - 1.0).stack()
    r = r[np.isfinite(r)]
    # 匹配基准：同宇宙同日、同 H 的全体等权收益
    bench = (fwd / entry - 1.0).where(valid).stack()
    bench = bench[np.isfinite(bench)]
    if len(r) == 0:
        return None
    ex = r.mean() - bench.mean()
    win = (r > 0).mean()
    pf = r[r > 0].sum() / abs(r[r < 0].sum()) if (r < 0).any() else np.inf
    return dict(label=label, H=H, n=len(r), mean=r.mean() * 100, med=r.median() * 100,
                bench=bench.mean() * 100, excess=ex * 100, win=win * 100, pf=pf,
                p90=r.quantile(.90) * 100, p10=r.quantile(.10) * 100)

# --- 变体 ---
variants = {}
for X in X_LIST:
    variants['V1 纯超跌 %.0f%%' % (X * 100)] = (ret20 <= -X)
    variants['V2 超跌%.0f%%+收阳' % (X * 100)] = (ret20 <= -X) & (cw > ow)
    variants['V3 超跌%.0f%%+缩量' % (X * 100)] = (ret20 <= -X) & (vr < 0.8)
    variants['V4 乖离<-%.0f%%' % (X * 100)] = (dev20 <= -X)
variants['V5 超跌20%+60日也跌'] = (ret20 <= -0.20) & (ret60 <= -0.25)

print('\n' + '=' * 100)
print('【全样本 2021-02 ~ 2026-09】超跌买点 vs 匹配基准（同宇宙同日等权）')
print('=' * 100)
print('%-24s %3s %8s %8s %8s %8s %7s %6s %8s %8s' %
      ('变体', 'H', 'n', 'mean%', 'bench%', 'excess%', 'win%', 'PF', 'p10%', 'p90%'))
for label, mask in variants.items():
    for H in H_LIST:
        rr = run(mask, label, H)
        if rr:
            results.append(rr)
            print('%-24s %3d %8d %8.2f %8.2f %8.2f %7.1f %6.2f %8.2f %8.2f' %
                  (rr['label'], rr['H'], rr['n'], rr['mean'], rr['bench'],
                   rr['excess'], rr['win'], rr['pf'], rr['p10'], rr['p90']))

pd.DataFrame(results).to_csv('/tmp/bt_oversold_full.csv', index=False)
print('\nsaved /tmp/bt_oversold_full.csv')
