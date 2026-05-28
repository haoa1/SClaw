/**
 * Email Tools — allows the AI agent to send arbitrary emails.
 *
 * Wraps the existing sendEmail() function from email.ts.
 * Supports both plain-text and HTML content.
 * SMTP must be configured via env vars (SMTP_HOST, SMTP_USER, SMTP_PASS).
 */

import { ToolRegistry, Tool } from "./registry";
import { sendEmail } from "../email";

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
}
