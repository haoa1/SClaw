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
function buildResultsTable(results: FilterResult[], maxRows = 30): string {
  const metricKeys = Object.keys(results[0]?.metrics || {});
  const rows = results.slice(0, maxRows);

  let html = `<table style="border-collapse:collapse;width:100%;font-size:13px;font-family:monospace;">
    <thead>
      <tr style="background:#1a1a2e;color:#e0e0e0;">
        <th style="border:1px solid #333;padding:6px 10px;text-align:left;">排名</th>
        <th style="border:1px solid #333;padding:6px 10px;text-align:left;">代码</th>
        <th style="border:1px solid #333;padding:6px 10px;text-align:left;">名称</th>
        <th style="border:1px solid #333;padding:6px 10px;text-align:right;">评分</th>`;

  for (const key of metricKeys) {
    const label =
      key === 'pe' ? 'PE' :
      key === 'pb' ? 'PB' :
      key === 'price' ? '价格' :
      key === 'changePercent' ? '涨幅%' :
      key === 'volume' ? '成交量' :
      key === 'marketCap' ? '市值' :
      key === 'turnover' ? '成交额' : key;
    html += `<th style="border:1px solid #333;padding:6px 10px;text-align:right;">${label}</th>`;
  }

  html += `<th style="border:1px solid #333;padding:6px 10px;text-align:left;">信号</th></tr></thead><tbody>`;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const bg = i % 2 === 0 ? '#0d0d1a' : '#1a1a2e';
    html += `<tr style="background:${bg};color:#ccc;">
      <td style="border:1px solid #333;padding:5px 10px;color:#888;">${i + 1}</td>
      <td style="border:1px solid #333;padding:5px 10px;font-family:monospace;">${r.code}</td>
      <td style="border:1px solid #333;padding:5px 10px;color:#e0e0e0;">${r.name}</td>
      <td style="border:1px solid #333;padding:5px 10px;text-align:right;color:${r.score >= 80 ? '#4ade80' : r.score >= 50 ? '#facc15' : '#888'};">${r.score}</td>`;

    for (const key of metricKeys) {
      const val = r.metrics[key];
      let display = '-';
      if (key === 'marketCap' && val) display = (val / 1e8).toFixed(0) + '亿';
      else if (key === 'volume' && val) display = (val / 10000).toFixed(0) + '万';
      else if (key === 'changePercent') display = val?.toFixed(2) ?? '-';
      else if (typeof val === 'number') display = val.toFixed(2);
      html += `<td style="border:1px solid #333;padding:5px 10px;text-align:right;">${display}</td>`;
    }

    html += `<td style="border:1px solid #333;padding:5px 10px;color:#888;">${r.signals.slice(0, 3).join('; ')}</td></tr>`;
  }

  html += '</tbody></table>';

  if (results.length > maxRows) {
    html += `<p style="color:#888;font-size:12px;">... 还有 ${results.length - maxRows} 只未显示</p>`;
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
): Promise<boolean> {
  const dateStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const html = `
    <div style="background:#0a0a1a;color:#ccc;padding:20px;font-family:sans-serif;">
      <h2 style="color:#e0e0e0;margin-bottom:16px;">📊 定时选股报告</h2>
      <div style="margin-bottom:16px;padding:12px;background:#1a1a2e;border-radius:8px;border:1px solid #333;">
        <p style="margin:4px 0;"><strong style="color:#888;">时间：</strong>${dateStr}</p>
        <p style="margin:4px 0;"><strong style="color:#888;">策略：</strong>${strategyNames.join('、')}</p>
        <p style="margin:4px 0;"><strong style="color:#888;">扫描：</strong>${stats.totalStocks.toLocaleString()} 只股票</p>
        <p style="margin:4px 0;"><strong style="color:#888;">命中：</strong><span style="color:#60a5fa;font-weight:bold;">${stats.matchedStocks.toLocaleString()} 只</span></p>
      </div>
      ${buildResultsTable(results)}
      <p style="color:#555;font-size:11px;margin-top:16px;">由 股海操盘手 定时任务自动发送</p>
    </div>
  `;

  return sendEmail({
    to,
    subject: `📊 选股报告 ${new Date().toLocaleDateString('zh-CN')}`,
    html,
    text: `选股报告 - ${dateStr}\n策略: ${strategyNames.join(', ')}\n扫描: ${stats.totalStocks} 只\n命中: ${stats.matchedStocks} 只`,
  });
}
