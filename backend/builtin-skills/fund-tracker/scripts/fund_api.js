#!/usr/bin/env node
/**
 * fund_api.js — East Money Fund Data API
 * ==========================================
 * Usage: node fund_api.js <action> [args...]
 *
 * Actions:
 *   search <keyword>         Search funds by name or code
 *   nav <fundCode>           Get real-time NAV (净值)
 *   holdings <fundCode>      Get top-10 holdings (持仓)
 *   historical-nav <fundCode> [pageSize=20]  Historical NAV
 *   list <type> [pageSize=100]  List funds by type (all/股票型/混合型/债券型)
 *
 * Output: JSON string to stdout
 * Errors: JSON { error: "..." } to stdout, exit code 0
 */

const https = require("https");
const http = require("http");

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// ===== HTTPS helper with timeout =====
function fetch(url, timeoutMs = 15000, extraHeaders = {}) {
  const mod = url.startsWith("https") ? https : http;
  const headers = { "User-Agent": USER_AGENT, ...extraHeaders };
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms: ${url}`));
    });
    req.on("error", reject);
  });
}

// ===== 1. Search funds =====
// East Money fund code search JS
async function searchFunds(keyword) {
  const js = await fetch("http://fund.eastmoney.com/js/fundcode_search.js", 10000);
  // Returns: var r = [[code, shortName, name, type, pinyin], ...]
  const match = js.match(/var r = (\[.*?\]);/);
  if (!match) return { error: "Failed to parse fund list" };

  let allFunds;
  try {
    allFunds = JSON.parse(match[1]);
  } catch {
    return { error: "Failed to parse fund data" };
  }

  const kw = keyword.toLowerCase().trim();
  const results = allFunds
    .filter((f) => {
      const [code, shortName, name, type] = f;
      return (
        code.includes(kw) ||
        shortName.toLowerCase().includes(kw) ||
        name.toLowerCase().includes(kw) ||
        type.toLowerCase().includes(kw)
      );
    })
    .slice(0, 20)
    .map((f) => ({
      code: f[0],
      shortName: f[1],
      name: f[2],
      type: f[3],
    }));

  return { action: "search", keyword, total: results.length, funds: results };
}

// ===== 2. Real-time NAV =====
async function getFundNav(fundCode) {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return { error: `Invalid fund code: ${fundCode}` };

  try {
    const jsonp = await fetch(
      `https://fundgz.1234567.com.cn/js/${code}.js`,
      10000
    );
    // Returns: jsonpgz({...});
    const match = jsonp.match(/jsonpgz\((.+)\)/);
    if (!match) return { error: `No data for fund ${code}` };

    const data = JSON.parse(match[1]);
    return {
      action: "nav",
      fundCode: code,
      fundName: data.name,
      nav: parseFloat(data.dwjz),       // 单位净值
      estimatedNav: parseFloat(data.gsz), // 估算净值
      changePct: parseFloat(data.gszzl), // 估算涨跌幅(%)
      navDate: data.jzrq,                // 净值日期
      estimateTime: data.gztime,         // 估算时间
    };
  } catch (err) {
    return { error: `Failed to get NAV for ${code}: ${err.message}` };
  }
}

// ===== 3. Top-10 holdings =====
async function getFundHoldings(fundCode) {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return { error: `Invalid fund code: ${fundCode}` };

  try {
    const html = await fetch(
      `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10`,
      15000
    );

    // Parse HTML table - extract stock names and holdings %
    const holdings = [];
    const rowRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || [];

    for (const row of rows) {
      const cells = [];
      let m;
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      while ((m = cellRegex.exec(row)) !== null) {
        // Strip HTML tags
        cells.push(m[1].replace(/<[^>]*>/g, "").trim());
      }
      if (cells.length >= 3 && cells[0].match(/^\d+$/)) {
        holdings.push({
          rank: parseInt(cells[0]),
          stockCode: cells[1] || "",
          stockName: cells[2] || "",
          // cells[6] is percentage (table has extra columns: price, change, links)
          percent: cells[6] ? parseFloat(cells[6].replace("%", "")) : null,
        });
      }
    }

    // Extract period info
    const periodMatch = html.match(/截止日期[：:]\s*([^<]+)/);
    const period = periodMatch ? periodMatch[1].trim() : "Unknown";

    return {
      action: "holdings",
      fundCode: code,
      period,
      total: holdings.length,
      holdings,
    };
  } catch (err) {
    return { error: `Failed to get holdings for ${code}: ${err.message}` };
  }
}

// ===== 4. Historical NAV =====
async function getHistoricalNav(fundCode, pageSize = 20) {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return { error: `Invalid fund code: ${fundCode}` };

  try {
    const text = await fetch(
      `https://api.fund.eastmoney.com/f10/lsjz?callback=jQuery&fundCode=${code}&pageIndex=1&pageSize=${pageSize}`,
      15000,
      { Referer: `https://fund.eastmoney.com/f10/jjjz_${code}.html` }
    );

    // Parse JSONP
    const match = text.match(/jQuery\((.+)\)$/);
    if (!match) return { error: `Failed to parse historical NAV for ${code}` };

    const data = JSON.parse(match[1]);
    if (!data.Data || !data.Data.LSJZList) {
      return { error: `No historical NAV data for ${code}` };
    }

    const records = data.Data.LSJZList.map((r) => ({
      date: r.FSRQ,
      nav: parseFloat(r.LJJZ) || 0,       // 累计净值
      unitNav: parseFloat(r.DWJZ) || 0,     // 单位净值
      dayChangePct: r.JZZZL
        ? parseFloat(r.JZZZL.replace("%", ""))
        : null,
    }));

    return {
      action: "historical_nav",
      fundCode: code,
      total: records.length,
      fundName: data.Data && data.Data.SHORTNAME ? data.Data.SHORTNAME : "",
      records,
    };
  } catch (err) {
    return { error: `Failed to get historical NAV for ${code}: ${err.message}` };
  }
}

// ===== 5. List funds by type =====
async function listFundsByType(typeFilter, pageSize = 100) {
  try {
    const js = await fetch("http://fund.eastmoney.com/js/fundcode_search.js", 10000);
    const match = js.match(/var r = (\[.*?\]);/);
    if (!match) return { error: "Failed to parse fund list" };

    let allFunds;
    try {
      allFunds = JSON.parse(match[1]);
    } catch {
      return { error: "Failed to parse fund data" };
    }

    // Type codes: 股票型=2, 混合型=3, 债券型=5, 货币型=6
    // The type field in the array is a Chinese type name
    let filtered = allFunds;
    if (typeFilter && typeFilter !== "all") {
      filtered = allFunds.filter((f) => f[3].includes(typeFilter));
    }

    const results = filtered.slice(0, pageSize).map((f) => ({
      code: f[0],
      shortName: f[1],
      name: f[2],
      type: f[3],
    }));

    return {
      action: "list",
      type: typeFilter || "all",
      total: filtered.length,
      shown: results.length,
      funds: results,
    };
  } catch (err) {
    return { error: `Failed to list funds: ${err.message}` };
  }
}

// ===== Main =====
async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || action === "--help" || action === "-h") {
    console.log(
      JSON.stringify({
        usage: "node fund_api.js <action> [args...]",
        actions: {
          search: "node fund_api.js search <keyword>",
          nav: "node fund_api.js nav <fundCode>",
          holdings: "node fund_api.js holdings <fundCode>",
          "historical-nav": "node fund_api.js historical-nav <fundCode> [pageSize]",
          list: "node fund_api.js list <type> [pageSize]",
        },
        examples: [
          'node fund_api.js search 易方达',
          'node fund_api.js nav 110011',
          'node fund_api.js holdings 110011',
          'node fund_api.js historical-nav 110011 10',
          'node fund_api.js list 股票型 20',
        ],
      })
    );
    return;
  }

  let result;
  switch (action) {
    case "search":
      result = await searchFunds(args[1] || "");
      break;
    case "nav":
      result = await getFundNav(args[1] || "");
      break;
    case "holdings":
      result = await getFundHoldings(args[1] || "");
      break;
    case "historical-nav":
      result = await getHistoricalNav(args[1] || "", parseInt(args[2]) || 20);
      break;
    case "list":
      result = await listFundsByType(args[1] || "all", parseInt(args[2]) || 100);
      break;
    default:
      result = { error: `Unknown action: ${action}. See --help` };
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.log(JSON.stringify({ error: err.message }));
});
