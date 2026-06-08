# 缠中说禅 (Chan Theory) — quantifiable stock screening strategies extracted from 112-chapter book

## Status: ✅ All files created locally, deploy script ready

**Date:** 2026-06-08

## Objective
Extract quantifiable stock screening strategies from 缠中说禅《教你炒股》108课 (112 chapters in full-text format) and implement them as both:
1. A **SClaw plugin** (`plugins/chan-theory-screener/`) — for the backend strategy engine
2. A **SClaw skill** (`backend/builtin-skills/chan-theory/`) — for AI agent knowledge injection

## Files Created

### Plugin: `plugins/chan-theory-screener/index.ts` (395 lines)
3 strategies, marketplace-discoverable with v1.0.0:
1. **chan-fractal** — 底分型选股: 日线三K线底分型形态, min vol ratio > 0.5
2. **chan-divergence** — 底背驰选股: MACD底背驰 + 价格新低, min vol ratio > 0.5
3. **chan-third-buy** — 第三类买点: 突破N日区间(20%+) + 缩量回踩(量比<0.7), min vol ratio > 0.7

### Skill: `backend/builtin-skills/chan-theory/SKILL.md` (236 lines)
Complete theory reference covering all 11 levels:
K线包含处理 → 分型 → 笔 → 线段 → 走势中枢 → 盘整/趋势 → 背驰 → 三类买卖点 → 走势分解 → 中阴阶段 → 两重表里关系
Plus: 实战框架 (选股策略、操作级别、资金管理、常见误区)

### Deploy Script: `deploy-chan-theory.sh`
Uploads reference materials + plugin + skill to server.

## Server-side Reference Materials
- `~/.sclaw/reference/chan-theory/缠中说禅.epub` — full book
- `~/.sclaw/reference/chan-theory/chan_theory_full.json` — 112 chapters as JSON
- `~/.sclaw/reference/chan-theory/key_theory.md` — 32 key chapters extracted

## Deployment
```
bash deploy-chan-theory.sh
```
Prerequisite: SSH to root@47.109.31.187 must work.

## Usage
Once deployed, AI can:
1. Read the skill's SKILL.md when user asks about 缠论
2. Use `strategy(sub_cmd="reload")` to load the plugin's 3 strategies
3. Run screens with `screen(run, strategies=["chan-fractal", ...])`
4. Reference the full book text from `file:///root/.sclaw/reference/chan-theory/`
