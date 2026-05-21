---
description: Fund data query and analysis — search funds, real-time NAV, top holdings, historical NAV
categories: [finance, data]
---

# Fund Tracker Skill 🏦

You have access to real Chinese fund (基金) data via the sandbox `run_script` tool + `fund_api.js` script. Use this skill when users ask about funds.

## Tools Available

- **`list_scripts`** — confirm fund_api.js is available
- **`run_script`** — execute fund_api.js with different actions

## Capabilities

### 1. Search Funds (`search`)
Search funds by keyword (name, code, or fund type).

```
run_script({ script: "fund_api.js", args: ["search", "keyword"] })
```

**Example:** `run_script({ script: "fund_api.js", args: ["search", "易方达"] })` → returns up to 20 matching funds with code, name, shortName, type.

### 2. Real-Time NAV (`nav`)
Get the latest NAV (estimated and actual) for a 6-digit fund code.

```
run_script({ script: "fund_api.js", args: ["nav", "fundCode"] })
```

**Example:** `run_script({ script: "fund_api.js", args: ["nav", "110011"] })` → returns current NAV, estimated NAV, change %, dates.

**Note:** ChangePct is the **estimated** intraday change (估算涨跌幅), not the official daily change (which updates at ~21:00 CST).

### 3. Top Holdings (`holdings`)
Get the most recent top-10 holdings of a fund.

```
run_script({ script: "fund_api.js", args: ["holdings", "fundCode"] })
```

**Example:** `run_script({ script: "fund_api.js", args: ["holdings", "110011"] })` → returns top 10 stocks held, with rank, code, name, and percentage.

### 4. Historical NAV (`historical-nav`)
Get historical NAV records for trend analysis.

```
run_script({ script: "fund_api.js", args: ["historical-nav", "fundCode", "pageSize"] })
```

**Example:** `run_script({ script: "fund_api.js", args: ["historical-nav", "110011", "30"] })` → returns 30 historical NAV records with date, unit NAV, cumulative NAV, daily change %.

### 5. List Funds by Type (`list`)
Browse funds by category.

```
run_script({ script: "fund_api.js", args: ["list", "type", "pageSize"] })
```

**Example:** `run_script({ script: "fund_api.js", args: ["list", "股票型", "10"] })` → lists top 10 equity funds.

**Common types:** 股票型 (equity), 混合型 (hybrid), 债券型 (bond), 货币型 (money market), 指数型 (index), QDII (overseas)

## Query Patterns

**"查一下 110011 基金的净值"** → `run_script({ script: "fund_api.js", args: ["nav", "110011"] })`

**"易方达有哪些基金"** → `run_script({ script: "fund_api.js", args: ["search", "易方达"] })`

**"这个基金买了什么股票"** → `run_script({ script: "fund_api.js", args: ["holdings", "fundCode"] })`

**"最近3个月的净值走势"** → `run_script({ script: "fund_api.js", args: ["historical-nav", "fundCode", "60"] })`

**"有哪些股票型基金"** → `run_script({ script: "fund_api.js", args: ["list", "股票型", "20"] })`

## Data Interpretation

- **NAV (单位净值):** The price per fund unit. Compare with historical NAV to assess performance.
- **Estimated NAV (估算净值):** Intraday estimate based on holdings' real-time prices (updates during trading hours).
- **Top Holdings:** Shows where the fund manager is allocating capital. High concentration (>50% in top 5) means concentrated risk.
- **Fund Types:**
  - 股票型: ≥80% in stocks — high risk/reward
  - 混合型: Mix of stocks and bonds — moderate
  - 债券型: ≥80% in bonds — low risk
  - 货币型: Money market — very low risk, liquid

## Safety Notes

- The fund_api.js script is read-only — it fetches public data via HTTP, never modifies anything.
- All results come with a 30-second timeout safeguard.
- Fund data from East Money is near-real-time for NAV estimates, T+1 for official NAV.
