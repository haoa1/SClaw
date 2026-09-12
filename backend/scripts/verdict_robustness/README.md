# verdict_robustness/ — 裁决稳健性证据脚本（研究产物，非生产代码）

**来源**：2026-09-12 从 `/tmp` 抢救归位。这些脚本是「避开超涨毒性排除」裁决与其
反证假说的**可复现证据**，原先只活在易失的 `/tmp` 里 —— 同一失败模式已经吃掉过
一次 `bt_signal_reconstruct.py`（结论因此作废，见 memory `sclaw_sellside_tp_sl.md` 顶部勘误）。

**定位**：⚠️ **不是生产代码，勿被例行/调度调用。** 生产评测器是同目录上方的
`../bt_avoid_toxic.py`（304 行，v2 原生，已入库 `deafbbd`）—— 要跑裁决请用它。
本目录只是证据存档：一次性、参数硬编码、输出到 `/tmp`。

## 各脚本证明什么

| 脚本 | 作用 | 对应结论 |
|---|---|---|
| `bt_grid.py` | 19 格稳健性网格（6 因子集 × H×excl 9 格 × 流动性阈值）+ 随机子集基线 | 全格为正；随机子集 ≡ 0.00000 ⇒ 超额来自「剔除谁」而非取样/规模/再平衡假象 |
| `bt_alpha_deep.py` | alpha 腿深挖（只剔除不止损）：H=5 vs H=10、逐年、OOS 两半、ac1 去自相关校正 | H=5/excl=0.30 稳健档（honest t≈3.39）；原主口径 H=10 仅 ~1.90 |
| `bt_rotation_edge.py` | 证伪「止损后轮动」补救假说 | 轮动无法救回止损造成的损失 |
| `forensic_fakegaps.py` | 证伪「除权裂口」补救假说 | 裂口不是收益缺口的来源 |
| `bt_leg_analysis.py` | 各腿归因（只剔除 / 只止损 / 两者） | 止损是负贡献（累计 79.4% → 53.8%） |

## 关键发现（写死在这里，防止再去重推）

- **差分类结论免疫地基缺陷，水位类不免疫。** clean_daily 的 qfq 减法复权缺陷是
  **全池共同基座偏移**，策略腿与基准腿读**同一列 close**，故
  `超额 = 策略 − 基准` 是一阶偏差自消的差分量。证据：本裁决在新旧基座上
  逐值复现（H=5 超额 +0.00119→+0.00117，t +3.68→+3.71），而水位类（累计、
  基准累计）整体同步下移（+79.4%→+72.2%）。
  ⇒ **今后凡「差分/超额/相对」类结论可跨基座沿用；凡「绝对水位/阈值」类必须换干净基座重报。**

## 复现方式

```bash
# 前置：生产库已切 v2（clean_daily.db，2026-09-12 20:34 完成）
cd /root/sclaw/backend
python3 scripts/verdict_robustness/bt_grid.py >> /tmp/bt_grid_out.log 2>&1
python3 scripts/verdict_robustness/bt_alpha_deep.py >> /tmp/bt_alpha_out.log 2>&1
```
耗时量级：各 ~10–30 min（全库 727 万行、并行只读）。输出 CSV 落 `/tmp`。

## 数据口径

- 库：`/root/sclaw/backend/data/clean_daily.db`（只读 `mode=ro`）
- 窗口：`2020-07-01 ~ 2026-09-11`（2020 前的行是少数长停牌壳股 1600 根窗口的尾巴，
  非全宇宙 —— 合规起点是 2020，见 memory `clean_daily_qfq_basis_defect.md` §D2）
- 方法学全文：memory `project/sclaw_avoid_toxic_clean_verdict.md`（§8/§9）
  与 `project/clean_daily_qfq_basis_defect.md`（§P12/§P13）
