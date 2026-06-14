# Serenity 瓶颈投资法 — 技能 + 插件已部署 ✅

## 部署内容

### 1. SKILL.md （AI 技能文件）
**路径（本地）：** `backend/builtin-skills/serenity-chokepoint/SKILL.md`
**路径（服务器）：** `/root/.sclaw/skills/serenity-chokepoint/SKILL.md`
**大小：** 5.7KB，170 行
**内容：** 完整投资框架：
- 核心哲学：投资于 AI 供应链结构性瓶颈
- 六层筛选漏斗（赛道→不可替代性→龙虾理论→地缘催化→机构→流动性）
- 持仓管理规则（Entry/Exit/Sizing）
- 5 个关键投资主题（CPO激光器、InP衬底、欧洲光子、OCS、日本供应链）
- 2025 已实现收益表（$ALAB 3.8x, $LITE 2.7x, $AAOI 5.8x, $EWY 4.8x）
- 当前持仓（$SIVE, $AXTI, $IQE, $XFAB）

### 2. 筛选插件
**路径（本地）：** `plugins/common/serenity-chokepoint/index.ts`
**路径（服务器）：** `/root/sclaw/plugins/common/serenity-chokepoint/index.ts`
**类型：** StockScreenerPlugin
**策略：** `chokepoint-screener` — 瓶颈筛选
- 参数：最大市值(亿)、最低涨幅%、最低量比
- 评分：市值越小越好（<30亿→+20分）+ 量比增量（>1.5→+10分）+ 正向动量
- Category: long-term（与 Serenity 的长期持有风格一致）

### 3. 推文参考数据
**路径（服务器）：** `/root/.sclaw/reference/serenity-chokepoint/tweets.json`
**内容：** 元数据 + 核心论 + 当前持仓/已实现收益

## 状态
- ✅ 插件已加载：`pm2 restart sclaw-backend` 后自动发现
- ✅ API 可见：`GET /api/plugins` 返回 `serenity-chokepoint` 及其策略
- ✅ 技能文件已部署：Agent 可通过 SKILL.md 路径读取

## 待办
- [ ] 如果需要在本地 TUI 加载技能，需确保本地 `shared/skills` 或 `builtin-skills` 路径正确
- [ ] 完整 280 条推文 JSON 待手动补全（当前仅存元数据结构）
