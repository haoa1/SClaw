/**
 * Email Tools — allows the AI agent to send arbitrary emails and formatted reports.
 *
 * Wraps the existing sendEmail(), sendScreenReport(), sendBacktestReport() functions from email.ts.
 * Supports both plain-text and HTML content.
 * SMTP must be configured via env vars (SMTP_HOST, SMTP_USER, SMTP_PASS).
 */

import { ToolRegistry, Tool } from "./registry";
import { sendEmail, sendScreenReport, sendBacktestReport } from "../email";
import { FilterResult } from "../types";

export function registerEmailTools(toolRegistry: ToolRegistry): void {
  toolRegistry.register(
    new Tool(
      "send_email",
      "Send an email to any recipient. Supports plain text and optional HTML content. " +
      "Use this to email fund reports, stock analysis summaries, or any other text-based report. " +
      "Provide a clear subject and meaningful body text. HTML is optional — plain text works too.",
      [
        {
          name: "to",
          type: "string",
          description: "Recipient email address (e.g. user@example.com)",
          required: true,
        },
        {
          name: "subject",
          type: "string",
          description: "Email subject line",
          required: true,
        },
        {
          name: "text",
          type: "string",
          description: "Plain text email body (required; used as fallback if HTML not provided)",
          required: true,
        },
        {
          name: "html",
          type: "string",
          description: "Optional HTML email body. If omitted, text is used as-is.",
          required: false,
        },
      ],
      async (args) => {
        const to = args.to as string;
        const subject = args.subject as string;
        const text = args.text as string;
        const html = args.html as string | undefined;

        if (!to || !subject || !text) {
          return "Missing required fields: to, subject, and text are required.";
        }

        const success = await sendEmail({ to, subject, text, html: html || text });
        if (success) {
          return `✅ Email sent to ${to}: "${subject}"`;
        }
        return "⚠️ Email not sent. SMTP may not be configured (set SMTP_HOST, SMTP_USER, SMTP_PASS) or the send failed.";
      }
    )
  );

  // ===== send_screen_report =====

  toolRegistry.register(
    new Tool(
      "send_screen_report",
      "Send a formatted stock screening report via email. Includes matched stocks table, scores, and signals. " +
      "Use this after running a screen to email results to the user.",
      [
        {
          name: "to",
          type: "string",
          description: "Recipient email address",
          required: true,
        },
        {
          name: "strategy_names_json",
          type: "string",
          description: 'JSON array of strategy names, e.g. ["volume-surge", "low-pe"]',
          required: true,
        },
        {
          name: "stats_json",
          type: "string",
          description: 'JSON string with screening stats: {"totalStocks": number, "matchedStocks": number, "executionTime": number}',
          required: true,
        },
        {
          name: "results_json",
          type: "string",
          description: 'JSON array of filter results: [{"code":"600000","name":"浦发银行","score":85,"signals":["signal1","signal2"],"metrics":{}}]',
          required: true,
        },
        {
          name: "agent_analysis",
          type: "string",
          description: "Optional AI analysis text (e.g. 缠论/筹码 analysis) to include in the email body",
          required: false,
        },
      ],
      async (args) => {
        const to = args.to as string;
        if (!to) return "Error: to is required";

        let strategyNames: string[];
        try { strategyNames = JSON.parse(args.strategy_names_json as string); }
        catch { return "Error: strategy_names_json must be a valid JSON array"; }

        let stats: { totalStocks: number; matchedStocks: number; executionTime: number };
        try { stats = JSON.parse(args.stats_json as string); }
        catch { return "Error: stats_json must be valid JSON"; }

        let results: FilterResult[];
        try {
          results = JSON.parse(args.results_json as string);
          if (!Array.isArray(results)) return "Error: results_json must be a JSON array";
        }
        catch { return "Error: results_json must be valid JSON"; }

        const agentAnalysis = args.agent_analysis ? String(args.agent_analysis) : undefined;
        const success = await sendScreenReport(to, stats, results, strategyNames, agentAnalysis);
        if (success) return `✅ Screen report sent to ${to}`;
        return "⚠️ Failed to send screen report. SMTP may not be configured.";
      }
    )
  );

  // ===== send_backtest_report =====

  toolRegistry.register(
    new Tool(
      "send_backtest_report",
      "Send a formatted backtest report via email. Includes return metrics, drawdown, Sharpe ratio, and trade log. " +
      "Use this after running a backtest to email results to the user.",
      [
        {
          name: "to",
          type: "string",
          description: "Recipient email address",
          required: true,
        },
        {
          name: "strategy_names_json",
          type: "string",
          description: 'JSON array of strategy names, e.g. ["my-strategy"]',
          required: true,
        },
        {
          name: "summary_json",
          type: "string",
          description: 'JSON with backtest summary: {"totalReturn": 25.5, "annualizedReturn": 12.3, "maxDrawdown": -8.5, "sharpeRatio": 1.5, "winRate": 62.5, "totalTrades": 120, "finalCapital": 125000, "benchmarkReturn": 5.2}',
          required: true,
        },
        {
          name: "trades_json",
          type: "string",
          description: 'JSON array of trades: [{"date":"2025-01-01","type":"buy","code":"600000","name":"浦发银行","price":10.5,"shares":1000,"amount":10500}]',
          required: true,
        },
        {
          name: "config_json",
          type: "string",
          description: 'JSON with backtest config: {"startDate":"2025-01-01","endDate":"2025-12-31","rebalanceFrequency":"monthly","initialCapital":100000,"benchmark":"000300.SH","stopLoss":-10,"takeProfit":20}',
          required: true,
        },
      ],
      async (args) => {
        const to = args.to as string;
        if (!to) return "Error: to is required";

        let strategyNames: string[];
        try { strategyNames = JSON.parse(args.strategy_names_json as string); }
        catch { return "Error: strategy_names_json must be a valid JSON array"; }

        let summary: any;
        try { summary = JSON.parse(args.summary_json as string); }
        catch { return "Error: summary_json must be valid JSON"; }

        let trades: any[];
        try {
          trades = JSON.parse(args.trades_json as string);
          if (!Array.isArray(trades)) return "Error: trades_json must be a JSON array";
        }
        catch { return "Error: trades_json must be valid JSON"; }

        let config: any;
        try { config = JSON.parse(args.config_json as string); }
        catch { return "Error: config_json must be valid JSON"; }

        const success = await sendBacktestReport(to, summary, trades, strategyNames, config);
        if (success) return `✅ Backtest report sent to ${to}`;
        return "⚠️ Failed to send backtest report. SMTP may not be configured.";
      }
    )
  );
}
