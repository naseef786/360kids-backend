import nodemailer from "nodemailer";
import { readFile } from "node:fs/promises";

export const BRAND_LOGO_CID = "360-kids-logo@360kidsactivity.com";
const brandLogoPath = new URL("../assets/360-kids-logo.png", import.meta.url);

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  brandLogo?: true;
}

export type EmailDeliveryMode = "disabled" | "smtp";

export interface SmtpOptions {
  host: string;
  port: 465;
  secure: true;
  auth: { user: string; pass: string };
  tls: { rejectUnauthorized: true; servername: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  disableFileAccess: true;
  disableUrlAccess: true;
}

export function emailConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.EMAIL_DELIVERY_MODE || "disabled";
  if (mode !== "disabled" && mode !== "smtp")
    throw new Error("Invalid email delivery mode.");
  if (mode === "disabled") return { mode } as const;
  const host = env.EMAIL_SMTP_HOST?.trim();
  const user = env.EMAIL_SMTP_USER?.trim();
  const password = env.EMAIL_SMTP_PASSWORD;
  const from = env.EMAIL_FROM?.trim();
  if (!host || !/^[a-z0-9.-]+$/i.test(host) || !user || !password || !from)
    throw new Error("SMTP delivery is not configured.");
  if (!validAddress(user) || !validAddress(from) || from !== user)
    throw new Error("SMTP sender identity is invalid.");
  if (env.EMAIL_SMTP_PORT !== "465")
    throw new Error("SMTP delivery requires implicit TLS on port 465.");
  return { mode, host, user, password, from } as const;
}

function validAddress(value: string) {
  // A single mailbox only: Nodemailer treats commas as recipient separators.
  return value.length <= 254 && /^[^\s@<>,;:"'()\[\]\\]+@[^\s@<>,;:"'()\[\]\\]+\.[^\s@<>,;:"'()\[\]\\]+$/.test(value);
}

export function validateEmailMessage(message: EmailMessage) {
  if (!validAddress(message.to) || !message.subject.trim() ||
      message.subject.length > 160 || /[\r\n]/.test(message.subject) ||
      !message.text.trim() || message.text.length > 8000)
    throw new Error("Email message is invalid.");
  if (message.html !== undefined && (!message.html.trim() || message.html.length > 16000))
    throw new Error("Email HTML is invalid.");
  if (message.brandLogo && (!message.html || !message.html.includes(`cid:${BRAND_LOGO_CID}`)))
    throw new Error("Branded email is missing its inline logo reference.");
}

/** Disabled by default. SMTP is never used unless explicitly selected and fully configured. */
export async function sendEmail(
  message: EmailMessage,
  env: NodeJS.ProcessEnv = process.env,
  deliver: (options: SmtpOptions, mail: {
    from: string; to: string; subject: string; text: string; html?: string;
    attachments?: Array<{filename:string;content:Buffer;contentType:string;cid:string;contentDisposition:"inline"}>;
  }) => Promise<{ accepted: Array<string | object> }> = async (options, mail) => {
    const transport = nodemailer.createTransport(options);
    return transport.sendMail(mail);
  },
): Promise<"disabled" | "accepted"> {
  validateEmailMessage(message);
  const config = emailConfig(env);
  if (config.mode === "disabled") return "disabled";
  const options: SmtpOptions = {
    host: config.host,
    port: 465,
    secure: true,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: true, servername: config.host },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  const attachments = message.brandLogo ? [{
    filename: "360-kids-logo.png",
    content: await readFile(brandLogoPath),
    contentType: "image/png",
    cid: BRAND_LOGO_CID,
    contentDisposition: "inline" as const,
  }] : undefined;
  const result = await deliver(options, {
    from: config.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...(attachments ? { attachments } : {}),
  });
  if (!result.accepted.length) throw new Error("SMTP did not accept the message.");
  return "accepted";
}
