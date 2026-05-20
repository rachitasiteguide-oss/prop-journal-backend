import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from './logger';

// ── Transport selection ───────────────────────────────────────────────────────
// Priority: Resend (production) → Google SMTP (MVP) → console.log (dev)

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

const smtpTransport =
  !resend && env.SMTP_USER && env.SMTP_PASS
    ? nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      })
    : null;

// ── Email HTML template ───────────────────────────────────────────────────────
function buildResetHtml(resetUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0D1610;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D1610;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#111916;border:1px solid rgba(58,74,63,0.4);border-radius:12px;padding:40px;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#00FFA3;">PROP JOURNAL</p>
              <h1 style="margin:0 0 24px;font-size:24px;font-weight:900;color:#F5FFF5;letter-spacing:-0.5px;">Reset your password</h1>
              <p style="margin:0 0 32px;font-size:15px;line-height:1.6;color:rgba(216,234,217,0.75);">
                We received a request to reset the password for your Prop Journal account. Click the button below to choose a new password. This link expires in <strong style="color:#F5FFF5;">1 hour</strong>.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td style="background:linear-gradient(135deg,#00FFA3,#00D488);border-radius:8px;">
                    <a href="${resetUrl}" style="display:inline-block;padding:14px 32px;font-size:13px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:#0D1610;text-decoration:none;">Reset Password</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px;font-size:13px;color:rgba(132,149,136,0.6);">
                If the button doesn't work, copy and paste this URL into your browser:
              </p>
              <p style="margin:0 0 32px;font-size:12px;color:rgba(132,149,136,0.5);word-break:break-all;">
                ${resetUrl}
              </p>
              <hr style="border:none;border-top:1px solid rgba(58,74,63,0.25);margin:0 0 24px;">
              <p style="margin:0;font-size:12px;color:rgba(132,149,136,0.5);">
                If you didn't request a password reset, you can safely ignore this email. Your password won't change.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

// ── Generic dispatcher ────────────────────────────────────────────────────────
// Single transport-selection point so every email type (reset, weekly review,
// future welcome mail) shares the Resend → SMTP → dev-log fallback chain.

async function dispatch(to: string, subject: string, html: string): Promise<boolean> {
  if (resend) {
    const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html });
    if (error) {
      logger.error(`Resend failed for ${to}: ${error.message}`);
      return false;
    }
    return true;
  }
  if (smtpTransport) {
    await smtpTransport.sendMail({ from: env.EMAIL_FROM, to, subject, html });
    return true;
  }
  logger.info(`[DEV] Email to ${to} — "${subject}" (no mail transport configured)`);
  return true;
}

// ── Weekly AI review email ────────────────────────────────────────────────────

function buildWeeklyReviewHtml(name: string, summary: string, stats: {
  totalClosed: number;
  totalPnL: number;
  winRate: number;
  profitFactor: number;
}): string {
  const pnlColor = stats.totalPnL >= 0 ? '#00FFA3' : '#ff6b6b';
  const pnl = `${stats.totalPnL >= 0 ? '+' : '-'}$${Math.abs(stats.totalPnL).toFixed(2)}`;
  const stat = (label: string, value: string, color = '#F5FFF5') => `
    <td style="padding:0 8px;">
      <table cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,0.03);border:1px solid rgba(58,74,63,0.4);border-radius:10px;width:100%;">
        <tr><td style="padding:14px;text-align:center;">
          <p style="margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:rgba(132,149,136,0.7);">${label}</p>
          <p style="margin:0;font-size:18px;font-weight:900;color:${color};">${value}</p>
        </td></tr>
      </table>
    </td>`;
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0D1610;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D1610;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111916;border:1px solid rgba(58,74,63,0.4);border-radius:12px;padding:40px;">
        <tr><td>
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#00FFA3;">PROP JOURNAL · WEEKLY REVIEW</p>
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:900;color:#F5FFF5;letter-spacing:-0.5px;">Your week in review${name ? `, ${name}` : ''}</h1>
          <p style="margin:0 0 28px;font-size:15px;line-height:1.6;color:rgba(216,234,217,0.75);">${summary}</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;"><tr>
            ${stat('Trades', String(stats.totalClosed))}
            ${stat('Net P&L', pnl, pnlColor)}
            ${stat('Win Rate', `${stats.winRate.toFixed(0)}%`)}
            ${stat('Prof. Factor', stats.profitFactor.toFixed(2))}
          </tr></table>
          <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;"><tr>
            <td style="background:linear-gradient(135deg,#00FFA3,#00D488);border-radius:8px;">
              <a href="${env.CLIENT_URL}/dashboard/ai-pattern" style="display:inline-block;padding:14px 32px;font-size:13px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:#0D1610;text-decoration:none;">View full analysis</a>
            </td>
          </tr></table>
          <hr style="border:none;border-top:1px solid rgba(58,74,63,0.25);margin:0 0 20px;">
          <p style="margin:0;font-size:12px;color:rgba(132,149,136,0.5);">You're receiving this because you logged trades in Prop Journal this week. Manage preferences in your account settings.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();
}

export async function sendWeeklyReviewEmail(
  to: string,
  name: string,
  summary: string,
  stats: { totalClosed: number; totalPnL: number; winRate: number; profitFactor: number },
): Promise<boolean> {
  return dispatch(to, 'Your Prop Journal weekly review', buildWeeklyReviewHtml(name, summary, stats));
}

// ── Welcome email ─────────────────────────────────────────────────────────────
// Exported separately so tests can snapshot the body without exercising the
// dispatcher.
export function buildWelcomeHtml(name: string | null, dashboardUrl: string): string {
  const greeting = name ? `Welcome, ${name}` : 'Welcome to Prop Journal';
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0D1610;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0D1610;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#111916;border:1px solid rgba(58,74,63,0.4);border-radius:12px;padding:40px;">
        <tr><td>
          <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#00FFA3;">PROP JOURNAL</p>
          <h1 style="margin:0 0 16px;font-size:24px;font-weight:900;color:#F5FFF5;letter-spacing:-0.5px;">${greeting}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:rgba(216,234,217,0.75);">
            Your account is live. Prop Journal is built for serious prop traders — track every trade across multiple firms, see real-time compliance against FTMO / Apex / Topstep rules, and get AI-driven reviews of your edge.
          </p>
          <p style="margin:0 0 12px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F5FFF5;">Start here</p>
          <ul style="margin:0 0 28px;padding:0 0 0 20px;font-size:14px;line-height:1.7;color:rgba(216,234,217,0.85);">
            <li>Connect an MT4 / MT5 account, or import a statement CSV</li>
            <li>Pick a prop firm template in Challenges to track your evaluation rules</li>
            <li>Log a trade with notes — the AI coach learns your patterns over time</li>
          </ul>
          <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
            <tr>
              <td style="background:linear-gradient(135deg,#00FFA3,#00D488);border-radius:8px;">
                <a href="${dashboardUrl}" style="display:inline-block;padding:14px 32px;font-size:13px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:#0D1610;text-decoration:none;">Open dashboard</a>
              </td>
            </tr>
          </table>
          <hr style="border:none;border-top:1px solid rgba(58,74,63,0.25);margin:0 0 20px;">
          <p style="margin:0;font-size:12px;color:rgba(132,149,136,0.5);">
            Questions? Reply to this email — a real person reads every reply.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`.trim();
}

export async function sendWelcomeEmail(to: string, name: string | null): Promise<boolean> {
  const dashboardUrl = `${env.CLIENT_URL}/dashboard`;
  return dispatch(to, 'Welcome to Prop Journal', buildWelcomeHtml(name, dashboardUrl));
}

// ── Sender ────────────────────────────────────────────────────────────────────
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const html = buildResetHtml(resetUrl);
  const subject = 'Reset your Prop Journal password';

  // ── Path 1: Resend (production) ───────────────────────────────────────────
  if (resend) {
    const { error } = await resend.emails.send({
      from: env.EMAIL_FROM,
      to,
      subject,
      html,
    });
    if (error) {
      logger.error(`Resend failed for ${to}: ${error.message}`);
      throw new Error('Failed to send password reset email');
    }
    return;
  }

  // ── Path 2: Google SMTP (MVP) ─────────────────────────────────────────────
  if (smtpTransport) {
    await smtpTransport.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject,
      html,
    });
    return;
  }

  // ── Path 3: Dev fallback ──────────────────────────────────────────────────
  logger.info(`[DEV] Password reset link for ${to}: ${resetUrl}`);
}
