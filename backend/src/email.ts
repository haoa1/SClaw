/**
 * Email sending utility using SMTP (nodemailer).
 * Configure via environment variables:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM
 *
 * If not configured, email sending is a no-op (logs instead).
 */

import 'dotenv/config';
import nodemailer from 'nodemailer';
import type { FilterResult } from './types';

// ===== Config =====

const SMTP_HOST = process.env['SMTP_HOST'] || '';
const SMTP_PORT = parseInt(process.env['SMTP_PORT'] || '587');
const SMTP_USER = process.env['SMTP_USER'] || '';
const SMTP_PASS = process.env['SMTP_PASS'] || '';
const EMAIL_FROM = process.env['EMAIL_FROM'] || SMTP_USER || 'noreply@stockscreener.local';

function isConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

let _transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!isConfigured()) return null;
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return _transporter;
}

// ===== Email builders =====

/** Build an HTML table from screening results */
/** Map stock code to exchange prefix for link */
function stockExchange(code: string): string {
  if (/^[69]/.test(code)) return 'sh';
  if (/^[03]/.test(code)) return 'sz';
  if (/^[48]/.test(code)) return 'bj';
  return 'sh';
}

/** Escape HTML entities to prevent XSS / broken email rendering */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Clickable stock link to eastmoney */
function stockLink(code: string, name?: string): string {
  const ex = stockExchange(code);
  const label = name || code;
  return `<a href="https://quote.eastmoney.com/${ex}${code}.html" target="_blank" style="color:#60a5fa;text-decoration:none;font-weight:500;">${escapeHtml(label)}</a>`;
}

/** Linkify stock codes (6-digit A-share codes) in text, after HTML-escaping */
function linkifyAnalysis(text: string): string {
  // Escape HTML first, then linkify stock codes so links are safe
  return escapeHtml(text).replace(/\b([0-9]{6})\b/g, (match, code) => {
    return stockLink(code);
  });
}

/** Build a beautiful re-scored results table (replaces the raw buildResultsTable) */
function buildScreenResultsTable(results: FilterResult[], maxRows = 30): string {
  if (!results || results.length === 0) return '<p style="color:#888;">无匹配结果</p>';
  const top = results.slice(0, maxRows);
  let html = `
    <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;width:100%;font-size:13px;font-family:'PingFang SC','Helvetica Neue',sans-serif;min-width:600px;">
      <thead>
        <tr style="background:linear-gradient(135deg,#1a1a3e,#2a1a4e);color:#e0e0e0;">
          <th style="border:1px solid #333;padding:8px 8px;text-align:center;width:36px;">#</th>
          <th style="border:1px solid #333;padding:8px 8px;text-align:left;min-width:60px;">代码</th>
          <th style="border:1px solid #333;padding:8px 8px;text-align:left;min-width:80px;">名称</th>
          <th style="border:1px solid #333;padding:8px 8px;text-align:center;width:48px;">评分</th>
          <th style="border:1px solid #333;padding:8px 8px;text-align:right;width:56px;">涨幅</th>
          <th style="border:1px solid #333;padding:8px 8px;text-align:right;width:48px;">量比</th>
          <th style="border:1px solid #333;padding:8px 8px;text-align:right;width:56px;">换手</th>
          <th style="border:1px solid #333;padding:8px 8px;text-align:right;width:60px;">市值</th>
          <th style="border:1px solid #333;padding:8px 8px;text-align:left;">缠论信号</th>
        </tr>
      </thead>
      <tbody>`;

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    const bg = i % 2 === 0 ? '#0d0d1a' : '#12122a';
    const scoreColor = r.score >= 80 ? '#4ade80' : r.score >= 60 ? '#facc15' : '#f87171';

    // Extract metrics
    const chg = r.metrics?.changePercent ?? 0;
    const volRatio = r.metrics?.volumeRatio ?? 0;
    const tr = r.metrics?.turnoverRate ?? 0;
    const mcap = r.metrics?.mcapYi ?? 0;
    const chanZhongshu = r.metrics?.chanZhongshu ?? 0;
    const chanBeichi = r.metrics?.chanBeichi ?? 0;
    const chanBuyPoint = r.metrics?.chanBuyPoint ?? 0;

    // Signals summary
    const signalBadges = r.signals?.slice(0, 3).map(s => {
      const isGood = s.includes('✓') || s.includes('买点') || s.includes('背驰');
      return `<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;margin:1px 2px;background:${isGood ? 'rgba(74,222,128,0.15)' : 'rgba(255,255,255,0.08)'};color:${isGood ? '#4ade80' : '#aaa'};">${s}</span>`;
    }).join('') || '';

    // Chan theory display
    let chanHtml = '';
    if (chanZhongshu > 0) {
      chanHtml += `<span style="color:#a78bfa;font-size:11px;">中枢✓</span>`;
    }
    if (chanBeichi > 0) {
      chanHtml += `<span style="color:#4ade80;font-size:11px;margin-left:4px;">背驰✓</span>`;
    }

    html += `<tr style="background:${bg};">
      <td style="border:1px solid #333;padding:6px 6px;text-align:center;color:#666;font-size:12px;">${i + 1}</td>
      <td style="border:1px solid #333;padding:6px 6px;font-family:monospace;font-size:12px;">${stockLink(r.code)}</td>
      <td style="border:1px solid #333;padding:6px 6px;color:#e0e0e0;font-size:13px;">${stockLink(r.code, r.name)}</td>
      <td style="border:1px solid #333;padding:6px 6px;text-align:center;font-weight:bold;color:${scoreColor};">${r.score}</td>
      <td style="border:1px solid #333;padding:6px 6px;text-align:right;color:${chg >= 0 ? '#f87171' : '#4ade80'};font-size:12px;">${typeof chg === 'number' ? (chg >= 0 ? '+' : '') + chg.toFixed(1) + '%' : '-'}</td>
      <td style="border:1px solid #333;padding:6px 6px;text-align:right;font-size:12px;">${typeof volRatio === 'number' ? volRatio.toFixed(2) : '-'}</td>
      <td style="border:1px solid #333;padding:6px 6px;text-align:right;font-size:12px;">${typeof tr === 'number' ? tr.toFixed(1) + '%' : '-'}</td>
      <td style="border:1px solid #333;padding:6px 6px;text-align:right;font-size:12px;color:#888;">${typeof mcap === 'number' ? mcap.toFixed(0) + '亿' : '-'}</td>
      <td style="border:1px solid #333;padding:6px 6px;font-size:11px;line-height:1.6;">${chanHtml || signalBadges || '<span style="color:#555;">-</span>'}</td>
    </tr>`;
  }

  html += '</tbody></table></div>';

  if (results.length > maxRows) {
    html += `<p style="color:#888;font-size:12px;margin-top:8px;">... 还有 ${results.length - maxRows} 只未显示</p>`;
  }

  return html;
}

// ===== Public API =====

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/** Send an email. Returns true on success, false if not configured / failed. */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) {
    console.log('[Email] Not configured. Would send:', options.to, options.subject);
    console.log('[Email] Body preview:', (options.text || options.html || '').slice(0, 200));
    return false;
  }

  try {
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    console.log(`[Email] Sent to ${options.to}: ${options.subject}`);
    return true;
  } catch (err) {
    console.error('[Email] Failed to send:', err);
    return false;
  }
}

/** Convenience: send a backtest report */
export async function sendBacktestReport(
  to: string,
  summary: {
    totalReturn: number;
    annualizedReturn: number;
    maxDrawdown: number;
    sharpeRatio: number;
    winRate: number;
    totalTrades: number;
    finalCapital: number;
    benchmarkReturn?: number;
  },
  trades: Array<{ date: string; type: string; code: string; name: string; price: number; shares: number; amount: number }>,
  strategyNames: string[],
  config: { startDate: string; endDate: string; rebalanceFrequency: string; initialCapital: number; benchmark: string; stopLoss?: number; takeProfit?: number },
): Promise<boolean> {
  const dateStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const excessReturn = summary.benchmarkReturn !== undefined
    ? summary.totalReturn - summary.benchmarkReturn
    : null;

  // Build trades table
  const topTrades = trades.slice(0, 20);
  const tradesTable = topTrades.length > 0 ? `
    <table style="border-collapse:collapse;width:100%;font-size:12px;font-family:monospace;margin-top:12px;">
      <thead>
        <tr style="background:#1a1a2e;color:#e0e0e0;">
          <th style="border:1px solid #333;padding:4px 8px;text-align:left;">日期</th>
          <th style="border:1px solid #333;padding:4px 8px;text-align:left;">操作</th>
          <th style="border:1px solid #333;padding:4px 8px;text-align:left;">代码</th>
          <th style="border:1px solid #333;padding:4px 8px;text-align:left;">名称</th>
          <th style="border:1px solid #333;padding:4px 8px;text-align:right;">价格</th>
          <th style="border:1px solid #333;padding:4px 8px;text-align:right;">数量</th>
          <th style="border:1px solid #333;padding:4px 8px;text-align:right;">金额</th>
        </tr>
      </thead>
      <tbody>
        ${topTrades.map((t, i) => {
          const bg = i % 2 === 0 ? '#0d0d1a' : '#1a1a2e';
          const typeColor = t.type === 'buy' ? '#4ade80' : '#f87171';
          return `<tr style="background:${bg};color:#ccc;">
            <td style="border:1px solid #333;padding:3px 8px;color:#888;">${t.date}</td>
            <td style="border:1px solid #333;padding:3px 8px;color:${typeColor};">${t.type === 'buy' ? '买入' : '卖出'}</td>
            <td style="border:1px solid #333;padding:3px 8px;">${t.code}</td>
            <td style="border:1px solid #333;padding:3px 8px;color:#e0e0e0;">${t.name}</td>
            <td style="border:1px solid #333;padding:3px 8px;text-align:right;">¥${t.price.toFixed(2)}</td>
            <td style="border:1px solid #333;padding:3px 8px;text-align:right;">${t.shares.toLocaleString()}</td>
            <td style="border:1px solid #333;padding:3px 8px;text-align:right;">¥${t.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    ${trades.length > 20 ? `<p style="color:#888;font-size:11px;">... 还有 ${trades.length - 20} 笔交易未显示</p>` : ''}`
    : '<p style="color:#888;">无交易记录</p>';

  const html = `
    <div style="background:#0a0a1a;color:#ccc;padding:20px;font-family:sans-serif;">
      <h2 style="color:#e0e0e0;margin-bottom:16px;">📊 定时回测报告</h2>

      <!-- Config Info -->
      <div style="margin-bottom:16px;padding:12px;background:#1a1a2e;border-radius:8px;border:1px solid #333;">
        <p style="margin:4px 0;"><strong style="color:#888;">时间：</strong>${dateStr}</p>
        <p style="margin:4px 0;"><strong style="color:#888;">策略：</strong>${strategyNames.join('、')}</p>
        <p style="margin:4px 0;"><strong style="color:#888;">期间：</strong>${config.startDate} → ${config.endDate}</p>
        <p style="margin:4px 0;"><strong style="color:#888;">再平衡：</strong>${config.rebalanceFrequency} | <strong style="color:#888;">基准：</strong>${config.benchmark}</p>
        <p style="margin:4px 0;"><strong style="color:#888;">初始资金：</strong>¥${config.initialCapital.toLocaleString()}</p>
        ${config.stopLoss !== undefined ? `<p style="margin:4px 0;"><strong style="color:#888;">止损：</strong>${config.stopLoss}%${config.takeProfit !== undefined ? ` | <strong style="color:#888;">止盈：</strong>${config.takeProfit}%` : ''}</p>` : ''}
      </div>

      <!-- Summary Metrics -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;">
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;">
          <div style="color:#888;font-size:11px;">总收益率</div>
          <div style="font-size:20px;font-weight:bold;color:${summary.totalReturn >= 0 ? '#4ade80' : '#f87171'};">${summary.totalReturn >= 0 ? '+' : ''}${summary.totalReturn.toFixed(2)}%</div>
        </div>
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;">
          <div style="color:#888;font-size:11px;">年化收益</div>
          <div style="font-size:20px;font-weight:bold;color:${summary.annualizedReturn >= 0 ? '#4ade80' : '#f87171'};">${summary.annualizedReturn >= 0 ? '+' : ''}${summary.annualizedReturn.toFixed(2)}%</div>
        </div>
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;">
          <div style="color:#888;font-size:11px;">最大回撤</div>
          <div style="font-size:20px;font-weight:bold;color:#f87171;">${summary.maxDrawdown.toFixed(2)}%</div>
        </div>
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;">
          <div style="color:#888;font-size:11px;">Sharpe</div>
          <div style="font-size:20px;font-weight:bold;color:${summary.sharpeRatio >= 1 ? '#4ade80' : '#facc15'};">${summary.sharpeRatio.toFixed(2)}</div>
        </div>
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;">
          <div style="color:#888;font-size:11px;">胜率</div>
          <div style="font-size:20px;font-weight:bold;">${summary.winRate.toFixed(1)}%</div>
        </div>
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:6px;padding:10px;text-align:center;">
          <div style="color:#888;font-size:11px;">交易次数</div>
          <div style="font-size:20px;font-weight:bold;">${summary.totalTrades}</div>
        </div>
      </div>

      <!-- Benchmark Comparison -->
      ${summary.benchmarkReturn !== undefined ? `
      <div style="margin-bottom:16px;padding:12px;background:#1a1a2e;border-radius:8px;border:1px solid #333;">
        <p style="margin:4px 0;"><strong style="color:#888;">最终资金：</strong>¥${summary.finalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
        <p style="margin:4px 0;"><strong style="color:#888;">基准收益率：</strong><span style="color:${summary.benchmarkReturn >= 0 ? '#4ade80' : '#f87171'};">${summary.benchmarkReturn >= 0 ? '+' : ''}${summary.benchmarkReturn.toFixed(2)}%</span></p>
        ${excessReturn !== null ? `<p style="margin:4px 0;"><strong style="color:#888;">超额收益：</strong><span style="color:${excessReturn >= 0 ? '#4ade80' : '#f87171'};">${excessReturn >= 0 ? '+' : ''}${excessReturn.toFixed(2)}%</span></p>` : ''}
      </div>` : `
      <div style="margin-bottom:16px;padding:12px;background:#1a1a2e;border-radius:8px;border:1px solid #333;">
        <p style="margin:4px 0;"><strong style="color:#888;">最终资金：</strong>¥${summary.finalCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
      </div>`}

      <!-- Trades Table -->
      <h3 style="color:#e0e0e0;font-size:14px;margin:16px 0 8px;">交易明细 (${trades.length})</h3>
      ${tradesTable}

      <p style="color:#555;font-size:11px;margin-top:16px;">由 股海操盘手 定时回测任务自动发送</p>
    </div>
  `;

  return sendEmail({
    to,
    subject: `📊 回测报告 ${new Date().toLocaleDateString('zh-CN')}`,
    html,
    text: `回测报告 - ${dateStr}\n策略: ${strategyNames.join(', ')}\n收益率: ${summary.totalReturn.toFixed(2)}%\n交易: ${summary.totalTrades}笔`,
  });
}
export async function sendScreenReport(
  to: string,
  stats: { totalStocks: number; matchedStocks: number; executionTime: number },
  results: FilterResult[],
  strategyNames: string[],
  agentAnalysis?: string,
): Promise<boolean> {
  const dateStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const analysisHtml = agentAnalysis ? `
    <div style="margin-bottom:16px;padding:16px;background:linear-gradient(135deg,#1a1a3e,#1a1a2e);border-radius:8px;border:1px solid #3a3a5e;">
      <h3 style="color:#a78bfa;margin:0 0 10px 0;font-size:15px;">🤖 AI 分析报告</h3>
      <div style="color:#ddd;line-height:1.8;font-size:14px;">${linkifyAnalysis(agentAnalysis.replace(/\n/g, '<br>'))}</div>
      <p style="color:#6b6b8a;font-size:11px;margin:10px 0 0;border-top:1px solid #2a2a4a;padding-top:8px;">💡 点击股票代码查看东方财富详情页</p>
    </div>` : '';
  const html = `
    <div style="background:#0a0a1a;color:#ccc;padding:20px;font-family:'PingFang SC','Helvetica Neue',sans-serif;">
      <div style="max-width:680px;margin:0 auto;">
      <div style="text-align:center;padding:20px 0 16px;border-bottom:1px solid #1a1a2e;margin-bottom:16px;">
        <h1 style="color:#e0e0e0;margin:0;font-size:18px;font-weight:600;">📊 定时选股报告</h1>
        <p style="color:#666;margin:4px 0 0;font-size:12px;">${dateStr}</p>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:120px;padding:10px 14px;background:#1a1a2e;border-radius:8px;border:1px solid #333;text-align:center;">
          <div style="color:#888;font-size:11px;">📈 策略</div>
          <div style="color:#e0e0e0;font-size:13px;font-weight:500;margin-top:2px;">${strategyNames.join('、')}</div>
        </div>
        <div style="flex:1;min-width:80px;padding:10px 14px;background:#1a1a2e;border-radius:8px;border:1px solid #333;text-align:center;">
          <div style="color:#888;font-size:11px;">📊 扫描范围</div>
          <div style="color:#e0e0e0;font-size:13px;font-weight:500;margin-top:2px;">${stats.totalStocks.toLocaleString()} 只</div>
        </div>
        <div style="flex:1;min-width:80px;padding:10px 14px;background:linear-gradient(135deg,#1a1a3e,#1a2a2e);border-radius:8px;border:1px solid #3a3a5e;text-align:center;">
          <div style="color:#888;font-size:11px;">🎯 命中</div>
          <div style="color:#60a5fa;font-size:20px;font-weight:bold;margin-top:2px;">${stats.matchedStocks.toLocaleString()}</div>
        </div>
      </div>
      ${analysisHtml}
      <div style="margin-bottom:8px;">
        <h3 style="color:#e0e0e0;font-size:14px;margin:0;">🏆 精选榜单 <span style="color:#666;font-weight:400;font-size:12px;">（综合评分排名）</span></h3>
      </div>
      ${buildScreenResultsTable(results)}
      <p style="color:#555;font-size:11px;margin-top:16px;text-align:center;border-top:1px solid #1a1a2e;padding-top:12px;">由 股海操盘手 定时任务自动发送 · 点击代码查看东方财富详情</p>
      </div>
    </div>
  `;

  return sendEmail({
    to,
    subject: `📊 选股报告 ${new Date().toLocaleDateString('zh-CN')}`,
    html,
    text: `选股报告 - ${dateStr}\n策略: ${strategyNames.join(', ')}\n扫描: ${stats.totalStocks} 只\n命中: ${stats.matchedStocks} 只${agentAnalysis ? '\n\n--- AI 分析 ---\n' + agentAnalysis : ''}`,
  });
}
