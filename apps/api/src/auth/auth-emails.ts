import { PASSWORD_RESET_EXPIRY_MINUTES } from './password-reset';

/**
 * Transactional security emails for staff accounts.
 *
 * Deliberately NOT routed through notifications/notification-templates.ts,
 * despite the visual duplication of the wordmark wrapper below. That system
 * is preference-gated (notification_preferences, business_notification_
 * settings) and writes a `notifications` row per send. Both are wrong here:
 *
 *  - A password reset must be deliverable to a user who has switched every
 *    notification off. Making account recovery opt-out-able would be a
 *    lockout bug wearing a feature's clothes.
 *  - `notifications` is a business-scoped feed (every eventType there
 *    carries a businessName). A reset happens against a global staff
 *    identity, before any business context exists -- there is no correct
 *    value to put in that column.
 *
 * So these render to a plain EmailMessage that AuthService hands straight to
 * EmailService. If a third transactional email ever appears here, the shared
 * `wrap()` styling is worth extracting into one module both files import;
 * with two templates, duplicating ~10 lines of inline CSS is cheaper than
 * the coupling.
 */

/** Mirrors notification-templates.ts's escapeHtml -- see the note above on
 * why these two files stay independent. Applied to the user's own full name,
 * which is user-controlled free text (signupSchema only length-caps it). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline-styled wordmark + footer, matching notification-templates.ts's
 * wrap() so both email families look like one product. All styling inline:
 * email clients strip <style> blocks. */
function wrap(bodyHtml: string): string {
  return (
    `<div style="font-family:sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5;">` +
    `<div style="padding-bottom:16px;margin-bottom:16px;border-bottom:2px solid #ecfdf5;">` +
    `<span style="font-size:18px;font-weight:700;color:#0f172a;">Echo</span>` +
    `<span style="font-size:18px;font-weight:700;color:#059669;">Grid</span>` +
    `</div>` +
    bodyHtml +
    `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">` +
    `An <span style="font-weight:600;color:#64748b;">INFINICUS</span> Company` +
    `</div>` +
    `</div>`
  );
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

/**
 * The reset link email. The raw token appears here and nowhere else -- it is
 * SHA-256 hashed before storage, so this message is the only copy that ever
 * exists in plaintext.
 *
 * The link is also rendered as visible text beneath the button: a meaningful
 * share of email clients block or mangle styled anchors, and a user who
 * cannot click still needs a way to complete recovery.
 */
export function renderPasswordResetEmail(fullName: string, resetLink: string): RenderedEmail {
  const safeName = escapeHtml(fullName);
  // The link is built from WEB_BASE_URL (operator-configured) plus a
  // hex-only token, so it carries no user-controlled content and needs no
  // escaping -- but it is still placed only in href/text positions, never
  // interpolated into an attribute that could break out of quoting.
  return {
    subject: 'Reset your Echo Grid password',
    html: wrap(
      `<p>Hi ${safeName},</p>` +
        `<p>We received a request to reset the password for your Echo Grid account. ` +
        `Click the button below to choose a new one. This link expires in ` +
        `${PASSWORD_RESET_EXPIRY_MINUTES} minutes and can only be used once.</p>` +
        `<p style="margin:24px 0;">` +
        `<a href="${resetLink}" style="display:inline-block;background:#059669;color:#ffffff;` +
        `text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;">` +
        `Reset password</a>` +
        `</p>` +
        `<p style="font-size:12px;color:#64748b;">Or paste this link into your browser:<br>` +
        `<span style="word-break:break-all;">${resetLink}</span></p>` +
        `<p style="font-size:12px;color:#64748b;">If you didn't request this, you can safely ` +
        `ignore this email — your password will not change.</p>`,
    ),
  };
}

/**
 * Sent after a password actually changes, by either route (reset link or an
 * authenticated change). This is the control that makes an undetected
 * takeover much harder: an attacker who resets a password still cannot stop
 * the real owner being told it happened. Deliberately has no link or action
 * -- a "wasn't me?" button in an email is itself a phishing template, so the
 * copy directs the user to request a reset themselves instead.
 */
export function renderPasswordChangedEmail(fullName: string): RenderedEmail {
  const safeName = escapeHtml(fullName);
  return {
    subject: 'Your Echo Grid password was changed',
    html: wrap(
      `<p>Hi ${safeName},</p>` +
        `<p>The password for your Echo Grid account was just changed, and you have been ` +
        `signed out on every device.</p>` +
        `<p style="font-size:12px;color:#64748b;">If this was you, no action is needed. ` +
        `If it wasn't, reset your password immediately from the Echo Grid login page and ` +
        `contact your administrator.</p>`,
    ),
  };
}
