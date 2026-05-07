import { Resend } from 'resend';
import { env } from '../config/env';
import { logger } from './logger';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  if (!resend) {
    logger.info(`[DEV] Password reset link for ${to}: ${resetUrl}`);
    return;
  }

  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to,
    subject: 'Reset your Prop Journal password',
    html: `
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
</html>
    `.trim(),
  });

  if (error) {
    logger.error(`Failed to send password reset email to ${to}: ${error.message}`);
    throw new Error('Failed to send password reset email');
  }
}
