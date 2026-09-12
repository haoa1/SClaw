# 切库 Runbook：clean_daily_v2.db → clean_daily.db

> 2026-09-12 建。配合 `promote_v2_to_prod.py`（门禁 1/2/3 + dry-run + 原子替换）。
> **核心风险不是脚本，是「谁还开着老库」。**

## 0. 前置条件（必须全部满足）

| # | 条件 | 检查方式 |
|---|---|---|
| 1 | v2 构建跑完：`done == prod codes (5550)`，无 todo | `promote_v2_to_prod.py` 门禁 1 |
| 2 | `v2_build.py` **进程已退出** | `pgrep -af v2_build.py` 为空 |
| 3 | 覆盖率（**同窗口**）≥99.5% **且** 逐股行数零差异 | 门禁 2（已修正，见 §8） |
| 4 | 腐蚀日 `gross <= 6`（已排除上市前5日窗口） | 门禁 3(旧序号) |
| 5 | **PROD 无其他进程持有** | 门禁 4：`openers_of(PROD)` |
| 6 | 磁盘可用 ≥ 2×（v2 大小 ×1.2） | 脚本自检（当前 84G 富余） |
| 7 | **无第三方持有者**（只允许 SClaw + 构建器） | `bash backend/scripts/holder_audit.sh` |

## 1. ★ 老库持有者 = 最大坑（实测）

`os.rename` **只替换目录项**，不碰 inode。已 `open()` 老库的进程仍指向**旧 inode**：

- 只读方 → 继续读到**旧数据**（stale，不报错！静默错）。
- 写入方 → 写进**已被换走的旧文件**（数据丢失，且新库看不到）。

实测持有者（2026-09-12 13:0x）：

| PID | 进程 | 说明 |
|---|---|---|
| 345871 | `node dist/index.js` | **SClaw 后端，常驻读**（FD 44r）→ 必须重启 |
| 389629 | `python3 /tmp/v2_build.py` | 构建器读 prod 作镜像源 → 跑完自然消失 |

⇒ **切库前必须重启 SClaw 后端**。脚本已内置 `openers_of()`（纯 /proc 扫描，不依赖 lsof）
硬门禁；确要强行继续用 `--ignore-holders`（自负风险）。

## 2. 执行顺序 ★用编排器（一键、可重入、带自动恢复）

> **为什么不能用「pkill SClaw → 切库 → 拉起」**（本 runbook 初版就是这么写的，**已作废**）：
> `garuda-mcp-bridge.service` 的 ExecStart 带 `--ensure --sclaw-cmd .../sclaw_launcher.py`，
> 而 `garuda_mcp.py::_listen_sse()` 是 `while True` 循环，**每次重连前都调 `_ensure_sclaw()`**。
> 于是单独 kill SClaw 后**约 5 秒它就会被桥接自动拉回来**，且若在 rename 之前起来 → 又抱住旧 inode。
> `mcp_listen.log` 里已有 **5 次实证**（`[ensure] SClaw MCP down ... starting: ...sclaw_launcher.py`）。
> ⇒ **桥接是唯一会自动拉起 SClaw 的 actor，必须先把它停掉。** 这正是 §2 初版会静默失效的原因。

### 已用受控实验复现（2026-09-12 13:17 · 隔离端口 3999）

不满足于历史日志，做了**带阴性对照**的直接实验：

| 阶段 | 动作 | 观测 |
|---|---|---|
| T0 | 假服务占住 :3999 | 端口开 |
| T1 | 假桥接（`--ensure`）启动 | `[ensure] SClaw MCP already up at 127.0.0.1:3999` → **SPAWN=0** ← 阴性对照：活着就不乱拉 |
| T2 | **kill 假服务** | 端口 :3999 关闭 |
| T3 | **+4 秒** | `[ensure] SClaw MCP down at 127.0.0.1:3999; starting: ...` → **SPAWN 13:17:30** ✅ |

⇒ 结论：**它管的进程一死，桥接 ≤5 秒就会把它拉回来。** 复现脚本（绝不触碰生产 3001）：
```bash
bash /root/sclaw/backend/scripts/probe_bridge_resurrect.sh
```
源码依据：`garuda_mcp.py` **401~403 行**（`while True` → `if ensure: _ensure_sclaw()`）、
**415~416 行**（断线 `reconnecting in 5s` 后回循环顶）、**314~340 行**（`_ensure_sclaw` → `Popen`）。

旁证（结构性）：`sclaw.service` 是 **disabled + inactive** —— SClaw **没有自己的守护单元**，
它此刻存在，纯粹因为桥接 spawn 了它。所以「停 SClaw」这件事，绕不开「先停桥」。

**时窗**：构建 ETA ≈ 15:50（pass 5 from 12:59:56, 2.08 s/只, todo=4847）。
故实际切库建议排在 **16:00 之后**（收盘 15:00 + 缓冲），避免盘中停 SClaw 导致盯盘中断。

```bash
cd /root/sclaw/backend/scripts

# ① 等构建真正结束（真值看驱动日志，**不要**用 done 计数估速率——批量 commit 会骗你）
pgrep -af v2_build.py                 # 必须为空
grep -E "^pass=|ALL DONE" /tmp/v2_driver.log | tail -3

# ② 彩排：走完 1~6 步但零改动（构建器还在跑时须加 --rehearse 才走得完）
python3 cutover_v2.py --rehearse

# ③ 真跑：停桥 → 停 SClaw → 门禁 replace → 起桥 → 验证新 inode
python3 cutover_v2.py --yes
```

编排器 `cutover_v2.py` 时序与自动恢复：

| 步 | 动作 | 失败时 |
|---|---|---|
| 1 | preflight：v2 就绪 / 构建器已退 / 持有者只有 SClaw | `ABORT` rc=2（零改动） |
| 2 | `systemctl stop garuda-mcp-bridge` | `ABORT` rc=3 |
| 3 | TERM SClaw → 等 fd 释放 + 端口让出（≤20s）→ 必要时 KILL | 自动起桥回滚 rc=4 |
| 4 | `promote_v2_to_prod.py --yes`（**只跑一次**；闸门自带备份+回滚） | 自动起桥 + 等 SClaw 回来 rc=5 |
| 5 | `systemctl start garuda-mcp-bridge`（ensure 会自动拉起 SClaw） | `ABORT` rc=6，附手动命令 |
| 6 | 验证：新 PID ≠ 旧 PID，且 fd inode == 新文件 inode | `WARN` rc=7，人工确认 |

**第 6 步是端到端铁证**：比对 `/proc/<new_pid>/fd/*` 的真实 inode 与 `clean_daily.db` 的 inode，
一致才算「SClaw 真的换到新库了」，不靠「进程起来了」这种弱信号。

防线是**双保险**：编排器 preflight 查一遍持有者，闸门 `check_v2` 自己也查一遍
（第 155 行 `openers_of(PROD)`，有持有者就直接拒绝，除非 `--ignore-holders`）。

### 手动兜底（仅当编排器不可用时）

```bash
systemctl stop garuda-mcp-bridge        # ★ 必须第一步，否则 SClaw 会被自动拉回
pkill -f "node dist/index.js"; sleep 3
ls -l /proc/*/fd 2>/dev/null | grep -c clean_daily.db    # 期望 0
cd /root/sclaw/backend/scripts
python3 promote_v2_to_prod.py           # 体检 + 预演
python3 promote_v2_to_prod.py --yes     # 真替换（先备份 .bak<ts> 再原子 rename）
systemctl start garuda-mcp-bridge       # ensure 自动拉起 SClaw
```

## 3. 回滚

脚本已保留 `clean_daily.db.bak<ts>`（同目录，同盘）：

```bash
systemctl stop garuda-mcp-bridge        # ★ 同样必须先停桥：否则 SClaw 5s 内被 ensure 拉回，又会抱住旧 inode
pkill -f "node dist/index.js"; sleep 3
ls -l /proc/*/fd 2>/dev/null | grep -c clean_daily.db    # 期望 0
mv /root/sclaw/backend/data/clean_daily.db.bak<ts> /root/sclaw/backend/data/clean_daily.db
systemctl start garuda-mcp-bridge       # ensure 自动拉起 SClaw（此时打开的是回滚后的库）
```

## 4. 第二阶段：重建 m30 / m60

切库完成后，**生产库本身就是修正后的 v2**，故：

```bash
cd /root/sclaw/backend/scripts
python3 build_m30_clean.py                      # 默认 --daily-db 即 clean_daily.db（已正确）
# 或显式： --daily-db data/clean_daily.db
```

`build_m30_clean.py` 已支持 `--daily-db PATH`（第 129/145 行），用于切换复权基座。
实测（2026-09-12 13:2x）：`clean_m30.db` / `clean_m60.db` **当前无任何进程持有** → Stage 2 重建**无需额外停服**（不必重复「停桥」那套）。
二阶污染说明：`clean_m30`/`clean_m60` 此前继承脏日线（m30 日末 close ≡ clean_daily.close），
故**必须**在切库后重跑，否则缠论/回测数据链仍是脏的。

## 5. 已知非阻塞项

- **1600 根深度截断**：v2 行骨架 ≡ prod 骨架（prod-mirror）。深度修复（Tencent API 实测能给 2843 根）列为**后续独立课题**，不阻塞本次。
⚠️ **前修正（旧版写「`--beg 2015-01-01` 实为 no-op、不丢历史」——已被 2026-09-12 实测证伪）**：
- `--beg 2015-01-01` **不是 no-op**，它真的按日期过滤了历史：
  - prod 日期跨度 **1993-11-26** ~ 2026-09-11（全史 7,804,461 行）
  - v2 日期跨度 **2015-01-05** ~ 2026-09-11（全量 7,728,713 行）
  - ⇒ 切库后 prod 将**丢掉 1993~2014 共 75,748 行**（占全史 1.0%）。
  - 但**同窗口（>=2015-01-05）内 v2 与 prod 逐股完全一致**（code 数 5467 vs 5467、行数零差）；
    83 只「只有 2015 前数据」的退市壳股本不该参与下游，丢弃无损。
  - 依据 **D2 决策**（下游最早用到 2020-07-01；2020-02 起约 95 交易日足够 MACD/缠论预热）
    已决定**不补跑**。若今后需更长历史，必须换「交易日历驱动」取数器（修改 `--beg` 无效）。
  - 旧库以 `clean_daily.db.bak<ts>` 完整保留，**可随时回滚**。
- `done` 表 `no_prod_rows` 40 只：prod 无对应行的票，非缺陷。


## 6. 构建吞吐与 ETA 口径（2026-09-12 实测）

**不要用 `done` 表的计数估速率** —— builder 是**批量 commit**，`done` 阶梯式跳变，
短窗口采样会得到「2 只/分钟」的假低速（我一度被它骗了）。**真值在驱动日志里**：

```bash
tail -3 /tmp/v2_driver.log
#   50/4847  ok=50 fail=0 infra=0 flagged=0  2.07s/只  ETA=165.8min
```

builder 自己打印 `x/Y ok=.. fail=.. infra=.. flagged=.. {秒}/只 ETA=..`，**以此为准**。
实测 pass 5：**2.07 s/只，ETA ≈ 166 min**（12:59:56 起 → 约 15:45 完成），`fail=0 flagged=0`。

## 7. 后续改进（构建结束后再做，勿在跑动中改）

1. **给 `v2_build.py` 加 `PRAGMA busy_timeout`**：
   本次 pass 2/3/4 连续 `database is locked` 整轮报废，根因是**读锁撞写锁**
   （见 memory §F3/G4）。加 `con.execute("PRAGMA busy_timeout=30000")` 可让写手
   自动等待而非立刻抛错，从根本上免疫间歇性读者。
   ⚠️ **构建跑完前不要改 `/tmp/v2_build.py`**（memory 已记；且改坏会在驱动里
   形成「秒崩—重启」死循环）。当前已通过「错开读写」缓解。
2. **深度修复**（1600 根截断 → Tencent 实测可给 2843 根）：需把行骨架从
   prod 镜像改为交易日历自生，属**独立课题**，不阻塞本次切库。


---

## 🐞 切库前审查发现并修复的两个缺陷（2026-09-12）

这两个都是**只在真正执行 `--yes` 时才会炸**的路径，dry-run 与门禁全绿也发现不了。
靠「切库前静态审查 + 隔离单测」提前拦下。

### 缺陷 1（会**丢元数据**）：staging 的 meta 只复制 v2，生产 meta 被整个丢弃

- **表象**：`promote_v2_to_prod.py` 建 staging 时，meta 是 `CREATE TABLE IF NOT EXISTS` 新建的**空表**，
  随后只有 `INSERT OR REPLACE INTO meta SELECT key,value FROM v2.meta` —— 且原来**只 ATTACH 了 v2，根本没读 prod**。
- **后果**：切库后 `clean_daily.db` 的 meta 变成 v2 的 `beg/end/method` 三条，
  **`volume_unit='手'`、`volume_src_div`、`volume_unit_hand_at`、`volume_unit_note` 全部消失**。
  这些是 2026-09-12 09:42 才落盘的口径凭证（688/689 ÷100、m30 ÷100、m60 原样、5199 只自证），
  丢了以后**再也没法从库里说明「volume 的单位是什么」**—— 属于静默的数据资产损失，不报错。
- **修复**：
  1. 增挂生产库只读：`ATTACH DATABASE 'file:...PROD?mode=ro' AS pdb`；
  2. 合并策略改为**生产为底**：先 `SELECT key,value FROM pdb.meta`，再 `SELECT 'v2_'||key, value FROM v2.meta`
     （v2 键统一加 `v2_` 前缀，`v2_method` 保留构建者口径，新 `method` 另写，互不覆盖）；
  3. **复验阶段加断言**：`lost = [k for k in ("volume_unit","volume_src_div") if k not in mm]`，
     丢了就 `os.rename(PROD, STAGE)` + 从备份 `shutil.move(bak, PROD)` 自动回滚，`sys.exit(4)`。

### 缺陷 2（会**卡死切库**）：`PRAGMA optimize` 在只读 ATTACH 库上直接抛异常

- **表象**：`sqlite3.OperationalError: attempt to write a readonly database`。
- **根因**：`PRAGMA optimize` 会遍历**所有 attached 数据库**（含 `mode=ro` 的 v2 / pdb），试图写统计信息。
- **后果**：异常发生在 `[1/4] 建暂存库` 结尾 → 整个提升**在 rename 之前就崩掉**，
  生产没被破坏（这点是好的），但**切库永远做不成**，且报错信息容易误判成「磁盘/权限问题」。
- **修复**：optimize 前先 `DETACH DATABASE v2` / `DETACH DATABASE pdb`，并把 optimize 降级为 `try/except` 告警。

### 验证方式（可复用）

`/tmp/test_meta_merge.py` —— **隔离单测**：只用 `prod.meta`（5 行，极小）造一个临时 staging，
跑与正式脚本**逐字相同**的三步合并 SQL，断言
(a) 生产 5 键原样保留 (b) v2 键带前缀 (c) 提升键就位。
**对构建库零干扰**（不碰 daily 大表），却能提前抓到只在 `--yes` 路径上出现的 bug。

> 教训：**dry-run 全绿 ≠ 真跑能成**。凡「只在真执行路径上出现」的分支（rename/model 合并/PRAGMA/DETACH），
> 一定要用隔离单测或小样本试跑覆盖，否则会在最不该失败的时刻失败。

#### 当前 meta 合并后的最终形态（11 键）

```
method                tencent_raw_x_baostock_multiplicative
promoted_at           2026-09-12 ...
promoted_from         clean_daily_v2.db
v2_beg                2015-01-01
v2_end                2026-09-11
v2_method             tencent_raw_x_baostock_foreAdjustFactor
volume_normalized_at  2026-09-12 09:47:05
volume_src_div        科创板(688/689)=100, 其他=1
volume_unit           手
volume_unit_hand_at   20260912_094239
volume_unit_note      2026-09-12 归一化到「手」: clean_daily 688/689 ÷100 (722970 行); ...
```

---

## 8. ⚠️ 门禁 2 口径修正（切库前的真正阻塞项，2026-09-12 晚）

### 症状

构建于 **15:47:02 `pass=6 rc=0 done=5550` ALL DONE** 正常结束，但正式提升被拒：

```
覆盖率: v2 7728713 / prod 7804461 = 99.03%
覆盖率 <99.5% -> 未跑完
[x] 门禁未通过（v2 可能未跑完）→ 拒绝提升
```

### 根因：口径不可比（假阴，非构建缺陷）

旧代码用 **v2 全量行数** 除以 **prod 全史 33 年**行数。但 v2 是带 `--beg 2015-01-01` 建的，
只重建 prod 的 2015 后窗口 → 分母天然多出 1993~2014 的 75,748 行 → **永远达不到 99.5%**。

### 独立复算（证据）

| 量 | 值 |
|---|---|
| prod 全史行数 | 7,804,461 |
| prod `date >= '2015-01-01'` | **7,728,713** |
| v2 全量行数 | **7,728,713** |
| 差 | **0** ✅ |
| prod `date < '2015-01-01'` | 75,748 |
| 行数缺口 | 75,748（与上行完全吻合）✅ |
| 逐股行数比对（v2 vs prod>=2015） | 不一致 **0** 只 ✅ |

### 修法（已落地于 `promote_v2_to_prod.py`）

1. prod 行数限制在 v2 窗口内：`count(*) ... where date >= ?`（? = v2.min(date)）；
2. **保持 99.5% 阈值不变**（修的是分母口径，不是调阈值）；
3. 新增**逐股行数零差异**强校验（比总量比严格得多）；
4. 显式打印被排除的 2015 前行数与 ⚠️ 提示，**不隐藏副作用**。

修正后实测（`promote_v2_to_prod.py` dry-run）：

```
覆盖率(同窗口 2015-01-05 起): v2 7728713 / prod 7728713 = 100.00%
  prod 全史 7804461 行；其中 2015-01-05 前的 75748 行不在 v2 窗口内
done 5550 / prod codes 5550
逐股行数比对: 不一致 0 只
v2 腐蚀日(gross=1.5×涨停以外) = 6          ← 6 ≤ 6，恰好卡在阈值上通过
!! 生产库被 1 个进程持有 -> 拒绝提升: 345871(node dist/index.js)
```

⇒ **数据质量门禁全绿**；唯一剩下的拒绝是门禁 3（SClaw 持有旧库），
**_而这正是 `cutover_v2.py` 第 2~3 步要消除的状态_**（单独跑门禁时 SClaw 还活着，拒绝是正确行为）。

### 教训

**门禁自身也会有 bug，而且是「永远拒绝」这种最难发现的那种。**
遇门禁拒绝时，先问「数据不行 还是 判断口径不行」，并用**独立 SQL 复算**
而非直接重跑构建。若当时误以为「构建没跑完」而重跑，会白烧 3 小时。


---

## 9. ✅ 执行记录：切库已完成（2026-09-12 20:30:35 → 20:34:14）

**结果：成功。生产库 `clean_daily.db` 已替换为修正后的 v2。**

```
[1/6] preflight     ✓ v2_build 已退出；唯一持有者 = SClaw 345871
[2/6] stop bridge   ✓ garuda-mcp-bridge 停止（摘除「自动拉起 SClaw」能力）
[3/6] stop SClaw    ✓ TERM → fd 释放 → 端口 3001 让出
[4/6] gate --yes    ✓ 建暂存 → 备份 → 原子 rename → 复验全绿（闸门自报耗时 84s）
[5/6] start bridge  ✓
[6/6] verify        ✗ 编排器自身 bug 崩溃（见下）→ 改由 /tmp/verify_cutover.py 复核 → 通过
```

**结果证据**

| 项 | 值 |
|---|---|
| prod 新 inode | `6720536` |
| SClaw 新 PID | 407929（旧 345871），fd 44 → inode `6720536` **= 新** ✅ |
| rows | 7,728,713 |
| 日期跨度 | 2015-01-05 ~ 2026-09-11 |
| codes | 5,467 |
| 索引 | `idx_daily_code` / `idx_daily_date` |
| meta | 11 键（**继承生产 5 键** `volume_unit=手` 等 + `v2_*` + `promoted_*`）|
| 功能读 | MCP `stock(history, 000892)` → 命中 `sqlite_clean_daily`，数据正确 |
| /mcp | HTTP 200 |
| 备份 | `clean_daily.db.bak1789216383`（1,184.7 MB，旧 inode 6720543）|

**🐞 编排器 bug（已修）**：`cutover_v2.py` 的 `step_verify()` 里
`"...-w %{http_code}..." % PORT` —— `%{` 是**非法 Python 格式符** → `ValueError`，
导致第 6 步在「SClaw 已复活」之后崩溃（RC=1）。
**切库本体早已成功，只是验证步骤被打断**。修法：`%%{http_code}`（已改并加注释）。
教训：**curl `-w` 的 `%{...}` 与 Python `%` 格式化冲突，必须先转义**。

**⚠️ 唯一待办**：`main.py` 的 `import logging` 修复（第 13 行，20:22 落盘）
**尚未生效** —— `garuda.service` 主进程 PID 356568 起于 08:50:34，早于文件 mtime，
需 `systemctl restart garuda.service` 才加载新代码。
**刻意未在无人值守时自动重启**（重启 = agent 下线、会中断进行中的会话），留给有意识的操作窗口。

**下一步**：§4 第二阶段 —— 重建 m30/m60（此时生产库已是干净复权基座）。

---

## 10. Stage 2 执行记录：重建 clean_m30 / clean_m60（2026-09-12 20:45:03 起）

### 10.1 为什么必须重跑（先用产物自证，再动手）

`clean_m30.db` / `clean_m60.db` 的 `meta` 表**自带输入指纹**，直接读即可判案：

| 产物 | built_at | meta.src_daily |
|---|---|---|
| `clean_m30.db` | 2026-09-12 10:12:02 | `clean_daily.db :: size=1184657408 mtime=1789177625 md5head=af09bc70f476` |
| `clean_m60.db` | 2026-09-12 10:18:14 | 同上 |
| **切库后 prod 现状** | 20:34:20 | `size=1133039616`（**不同**） |

`1184657408` 恰好 == `clean_daily.db.bak1789216383`（旧库）。
⇒ **两个 clean 分钟库都是拿「脏日线」建的**，属二阶污染，必须在切库后重跑。判据不靠回忆，靠产物指纹。

### 10.2 ⚠️ 方法论纠正：一次被自己的过滤器骗了的结论

本次侦察中先说「`clean_m30` 无任何运行时引用」，**该结论是错的**。
原因：我 grep 时加了 `grep -v "/data/"` 和 `awk '!/\.db/'` 过滤，
而**真相恰好就在含 `data/` 与 `.db` 的那几行里**，被我自己滤掉了。
去掉过滤后真相：

- `src/chan/service.ts:36` → 加载 `data/clean_m30.db`（注释：为避免"日线前复权 × 30m 未复权"的跨口径拼接）
- `src/data/data-fetcher.ts:13` → `CLEAN_M30_DB`（回测取数）

⇒ 这两个库**是活引用**，缠论与回测正在读被污染的分钟库。Stage 2 不是清理，是修链。
**教训：过滤条件本身就是假设；过滤后"找不到"必须先怀疑过滤器。**

### 10.3 ⚠️ 方法论纠正：锚点日期陷阱（验证口径）

用「m30 日末 close 是否 == clean_daily.close」判是否已复权时，
**不能取最新交易日**：前复权锚定在最新价，该日 `factor ≡ 1.0` 是**定义使然**，
于是必然 100% 相等 —— 什么都证明不了（我第一版就踩了，5204/5204 全等）。
改取旧日期后才有区分度（如 2025-09-08 仅 81.5% 相等、比值 0.990~1.027）。
**教训：验证要选"若假设为假则必然不同"的样本点；锚点/边界点通常是最坏的检验点。**

### 10.4 干跑验证（先小样本，再全量）

`build_m30_clean.py --dry --limit 200`（30m 47s / 60m 35s）：

- 复权基座解析为 `/root/sclaw/backend/data/clean_daily.db`（**已是 v2**）✓
- 因子越界 = 0 ‖ 因子跳变(>50%) = 0 ‖ 缺 qfq 日线 = 0 ‖ 残渣 = 0
- 量纲自证：`volume_src_div=100.0`（30m 源=股 → 手）

按实测吞吐推算全量：**m30 ≈ 20 min，m60 ≈ 15 min，合计 ≈ 35 min**。

### 10.5 启动方式（独立 cgroup，抗 Garuda 重启）

```
systemd-run --unit=sclaw-rebuild-minute-<HHMMSS> --collect --property=Type=oneshot \
  /bin/bash /root/sclaw/backend/scripts/rebuild_clean_minute.sh
```
- 走**既有编排器** `rebuild_clean_minute.sh`（串行 30→60，末尾跑 Step2 验收），不新写脚本。
- 该脚本用**默认 `--daily-db`** → 自动指向 prod `clean_daily.db`（现在是 v2），无需改参数。
- 单元名：`sclaw-rebuild-minute-204503`，日志 `scripts/logs/rebuild_clean.log`。
- **特意放进独立 cgroup**：这样 `systemctl restart garuda.service`（§9 待办）**不会**把这个长任务团灭。

### 10.6 已知风险（已接受）

`build_m30_clean.py` 先 `os.rename(旧库 → .bak)` 再创建新库 ⇒ 存在**短暂窗口新库不存在**，
此时若有请求读 `clean_m30.db`（缠论/回测）会失败。
选周六夜执行，盘中无请求；且 `997f33fd`（工作日 16:20 分时数据例行）会每日重跑覆盖。
旧库均留有 `.bak<ts>`，可回滚。

### 10.7 顺带清理：两个 v2 时代定时任务已废弃

| 任务 | cron | 处置 |
|---|---|---|
| `961445eb` v2重建看门人 | `*/30 * * * *` | **已禁用**。只读看门狗，但 v2 已完工仍每 30 分钟唤醒 AI 复述旧闸门摘要，纯噪声 |
| `9d391b9c` v2切库前置检查 | `5 16 * * *` | **已禁用**。切库已验收完成，任务已无标的 |

两者均属「任务已完成但调度未撤」的遗留；toggle 可随时恢复。
（`086d47bc` 周末回测流水线实为 `enabled=False` 且绑 Windows `D:\`，与本次无冲突。）

### 10.8 ✅ Stage 2 完成：clean_m30/m60 在 v2 基座上重建（2026-09-12 20:45 → 21:04）

独立 cgroup（`sclaw-rebuild-minute-204503`），m30 354s + m60 354s。
产物：m30 9,687,567 行 / 残渣 2,896（全 `no_qfq_daily`）；m60 4,235,334 行 / 残渣 0；跨度均 2025-09-08 ~ 2026-09-11。

**二阶污染已除**：两库 `meta.src_daily` 均 `size=1133039616`（= 切库后 v2 prod），不再指向旧脏库（`1184657408`）。

**canonical 验收通过**：`python3 scripts/verify_minute_clean.py` → `VERIFY_RESULT: OK ✅` RC=0
（A行数/B因子/C聚合/D量额/E形态/G量纲；[B] 最大因子偏差 0.00e+00；[G] median(daily/minute)=1.0000）。

#### 10.8.1 假警报：`Step2 验收结论: 失败 ❌ D 量额被改动`

`rebuild_clean_minute.sh` 原调 **`/tmp/verify_step2.py`** —— 两处硬伤：
① **易失**（/tmp 被清即丢闸门）；② **过期**（副本停在 09:03，其 `[D]` 断言「量额不变」，
而 `build_m30_clean.py` 12:45 起自己做股→手归一 `vol_div=100` ⇒ m30 必然误报；m60 `div=1` 故不受影响）。

**判据坏，不是数据坏**：失败样本恰好 ×100 且 amount 逐条不变（257480576 == 257480576）；
独立复算体积不变量三日期 median(daily/minute)=1.0000。
**已修**：改调仓内 canonical `verify_minute_clean.py`（带 `vol_div` + `[G]`），并打印 `rc=`。
**⚠️ 例行任务从未坏过**：`routine_build_minute.sh:230` 本来就调 canonical 验收器；坏的只有手动路径。

#### 10.8.2 ★ 真发现：`stock_kline_30m` 并非"未复权(raw)"，而是**已前复权**

`build_m30_clean.py` 的立足点（「30m 源 = 腾讯 mkline = 未复权」）**只对约一半**。
铁证（001388，除权日 2026-07-17，10送5）：除权前 30m 末根 close = `23.75499472` **恰等于 clean_daily qfq**，
而 60m 末根 = `35.68`（raw），比值 `0.665779 ≈ 1/1.5`。
面（同 (code,date) 直比两源表，交集 1,015,695 个股票日）：**44.30% 不一致**，比值集中 0.992~0.999（小额分红因子）；
极端例 `301550 2025-11-17`：30m=60.4848244 vs 60m=127.6（比值 0.4740）。
最可能成因：30m 由 baostock 前复权回补，60m 由腾讯 mkline 原样入库。

**产物为何仍正确**：`factor = clean_daily.qfq_close / 源当日末根close`，对该日全部 bar 同乘 ⇒ **口径无关**，
已复权时因子退化为 1.0（直通）。**遗留陷阱**：任何新消费者若假定 `stock_kline_30m` 是 raw，会错 44%。
#### 10.8.3 全库口径定量（2026-09-12 深夜补测：把 §10.8.2 的「约一半」钉死）

全库逐 `(code,date)` 求 `源末根close / clean_daily.qfq_close`：

| 交易日 | 30m == qfq | 30m 比值 min/med/max | 60m == qfq | 60m 比值 min/med/max |
|---|---|---|---|---|
| 2026-09-11（近端） | **5204/5204 = 100%** | 1.0000 / 1.0000 / 1.0000 | **5204/5204 = 100%** | 1.0000 |
| 2025-11-17（远端） | 4180/4716 = **88.6%** | 0.9839 / 1.0000 / 1.0277 | 1591/4716 = **33.7%** | 1.0000 / 1.0043 / **2.1096** |

⇒ **30m 源 ≈ 前复权(qfq)**（远端 11.4% 微偏 ±2% 内，疑 baostock 分批取数、qfq 锚点日不同）
⇒ **60m 源 ≈ 后复权(hfq)**（远端 63.6% 高于 qfq，最大 2.1096×）
**独立交叉验证**：`clean_m60.meta.factor_range` 下界 `0.474019` ≈ `1/2.1096` —— 两处独立算出的数完全吻合，
坐实「60m 是 hfq、builder 已把它正确折算回 qfq」这一解释（不是巧合，也不是数据错）。

**docstring 已修**（2026-09-12 深夜）：`build_m30_clean.py` 文件头加「2026-09-12 晚实测修正」块，写明
① 原假设「30m = 未复权」**有误**；② 设计对源口径**不敏感**，故产物仍正确；
③ 不要把这一条当成「产物有问题」的信号。**纯注释改动，未动任何逻辑**，`py_compile` 通过。

**弃用遗留（非阻塞，⚠️ 勿回补）**：`stock_history.db.stock_daily` 冻结于 `max(date)=2026-09-08`，
而 30m/60m/`clean_daily` 均已到 `2026-09-11`。**2026-09-12 21:2x 复核**：核 `~/.garuda/data/scheduled_tasks.json`
全部 10 项任务，**无任何一项写 `stock_history.db`** ⇒ 这是迁移后**主动弃用**的 raw 库，不是「坏掉的待补任务」。
在跑的日更链是 `997f33fd 分时数据例行`（Mon 16:20）+ `671242e6 巡检`（Mon 17:50），二者均调仓内脚本。
`chan/service.ts` 主路径读 clean 库且向上游带 `caliber` 标注，只有 fallback 才会拿到这份旧 raw 日线。

#### 10.8.4 已知非阻塞标记

m60 `adj_audit` 有 3 条 `big_jump`（001388 2026-07-17 / 603409 2026-06-18 / 688332 2026-05-18），
均为 10送5 级别真实除权（因子 ~0.665 → 1.0），**非缺陷**；两库验收均不把 `[F]` 计入失败判据。
