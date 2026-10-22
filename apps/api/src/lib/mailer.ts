import nodemailer, { type Transporter } from "nodemailer";
import { loadEnv } from "../env.js";
import { logger } from "./logger.js";

let transport: Transporter | null | undefined;

function getTransport(): Transporter | null {
  if (transport !== undefined) return transport;
  const url = loadEnv().SMTP_URL;
  transport = url ? nodemailer.createTransport(url) : null;
  return transport;
}

export function isMailConfigured(): boolean {
  return Boolean(loadEnv().SMTP_URL);
}

export interface MailResult {
  sent: boolean;
  error?: string;
}

/** Sends a plain-text email when SMTP_URL is configured. Never throws. */
export async function sendMail(to: string, subject: string, text: string): Promise<MailResult> {
  const t = getTransport();
  if (!t) return { sent: false, error: "mail_not_configured" };
  try {
    await t.sendMail({ from: loadEnv().MAIL_FROM, to, subject, text });
    return { sent: true };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "email send failed");
    return { sent: false, error: "send_failed" };
  }
}
