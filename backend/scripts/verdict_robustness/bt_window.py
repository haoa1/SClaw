import sqlite3
c = sqlite3.connect("file:/root/sclaw/backend/data/clean_daily.db?mode=ro", uri=True)
ds = [r[0] for r in c.execute(
    "select distinct date from daily where date>='2020-07-01' and date<='2026-09-11' order by date")]
n = len(ds)
print("窗口内交易日 n =", n)
print("首日", ds[0], " 末日", ds[-1])
for mt in (60,):
    reb = list(range(20 + mt, n - 10, 10))
    print("min_listed=%d -> reb_idx[0]=%d -> 首调仓日 %s" % (mt, reb[0], ds[reb[0]]))
    print("  调仓期数 =", len(reb), " 末调仓日 =", ds[reb[-1]],
          " 末期出场日 =", ds[min(reb[-1] + 10, n - 1)])
    print("  覆盖跨度 = %s ~ %s" % (ds[reb[0]], ds[min(reb[-1] + 10, n - 1)]))
print()
# 全库
print("全库 min/max:", c.execute("select min(date), max(date) from daily").fetchone())
print("全库 >2020 交易日:", c.execute(
    "select count(distinct date) from daily where date>='2020-01-01'").fetchone()[0])
