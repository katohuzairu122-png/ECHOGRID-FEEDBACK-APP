/**
 * Per-event template data, keyed to eventType via a discriminated union so
 * a caller can never pass 'points_earned' data shaped for 'tier_upgraded'
 * without a type error. Deliberately plain data (numbers/strings), not
 * pre-formatted HTML fragments -- rendering (renderNotification below) is
 * the one place that decides presentation, so both channels stay in sync
 * with each other by construction.
 */
export type NotificationTemplateData =
  | { eventType: 'feedback_received'; businessName: string; branchName: string; rating: number; comment?: string | undefined }
  | { eventType: 'summary_ready'; businessName: string; periodLabel: string }
  | {
      eventType: 'redemption_pending';
      businessName: string;
      rewardName: string;
      redemptionCode: string;
    }
  | { eventType: 'points_earned'; businessName: string; pointsEarned: number; newBalance: number }
  | { eventType: 'tier_upgraded'; businessName: string; tierName: string }
  | { eventType: 'reward_redeemed'; businessName: string; rewardName: string }
  | { eventType: 'message_received'; businessName: string; preview: string }
  | { eventType: 'message_reply_received'; businessName: string; customerLabel: string; preview: string };

export interface RenderedNotification {
  subject: string;
  emailHtml: string;
  smsText: string;
}

/** Minimal HTML escaping for the handful of user-controlled strings that
 * ever reach a template (business/branch/reward names, feedback comments) --
 * this platform has no HTML-templating library, and these strings can
 * originate from public, unauthenticated input (a QR feedback comment), so
 * skipping this would be a real stored-XSS-in-email vector. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Text-only styled wordmark, not a hosted/embedded logo image -- avoids
 * cross-client image-blocking and hosting-reliability issues (same
 * reasoning as the OG image's font-fetch tradeoff, see _social-image.tsx).
 * Easy to upgrade to a hosted image later once a stable production domain
 * exists. All styling is inline (no external CSS/Tailwind classes) since
 * email clients strip <style> blocks and most external stylesheets. */
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

/**
 * One render function, not per-channel duplicates -- each branch below
 * builds subject + emailHtml + smsText together so the same underlying
 * copy never drifts between channels. NotificationDeliveryService (Block 2)
 * picks whichever of emailHtml/smsText its channel needs and ignores the
 * other.
 */
export function renderNotification(data: NotificationTemplateData): RenderedNotification {
  switch (data.eventType) {
    case 'feedback_received': {
      const stars = '★'.repeat(data.rating) + '☆'.repeat(5 - data.rating);
      const commentLine = data.comment ? `"${escapeHtml(data.comment)}"` : '(no comment left)';
      return {
        subject: `New ${data.rating}-star feedback at ${data.branchName}`,
        emailHtml: wrap(
          `<p>New feedback at <strong>${escapeHtml(data.branchName)}</strong> (${escapeHtml(data.businessName)}):</p>` +
            `<p>${stars}</p><p>${commentLine}</p>`,
        ),
        smsText: `New ${data.rating}-star feedback at ${data.branchName}: ${data.comment ? data.comment.slice(0, 100) : '(no comment)'}`,
      };
    }
    case 'summary_ready':
      return {
        subject: `Your ${data.businessName} feedback summary is ready`,
        emailHtml: wrap(
          `<p>A new AI summary for <strong>${escapeHtml(data.businessName)}</strong> (${escapeHtml(data.periodLabel)}) is ready. Open your dashboard's Analytics page to view it.</p>`,
        ),
        smsText: `Your ${data.businessName} feedback summary for ${data.periodLabel} is ready -- check your dashboard.`,
      };
    case 'redemption_pending':
      return {
        subject: `Redemption waiting: ${data.rewardName}`,
        emailHtml: wrap(
          `<p>A customer at <strong>${escapeHtml(data.businessName)}</strong> wants to redeem <strong>${escapeHtml(data.rewardName)}</strong>.</p>` +
            `<p>Confirmation code: <strong>${escapeHtml(data.redemptionCode)}</strong></p>`,
        ),
        smsText: `Redemption pending at ${data.businessName}: ${data.rewardName} (code ${data.redemptionCode})`,
      };
    case 'points_earned':
      return {
        subject: `You earned ${data.pointsEarned} points at ${data.businessName}`,
        emailHtml: wrap(
          `<p>You just earned <strong>${data.pointsEarned} points</strong> at ${escapeHtml(data.businessName)}.</p>` +
            `<p>New balance: <strong>${data.newBalance}</strong> points.</p>`,
        ),
        smsText: `You earned ${data.pointsEarned} points at ${data.businessName}! New balance: ${data.newBalance}.`,
      };
    case 'tier_upgraded':
      return {
        subject: `You've reached ${data.tierName} at ${data.businessName}!`,
        emailHtml: wrap(
          `<p>Congratulations! You've reached <strong>${escapeHtml(data.tierName)}</strong> status at ${escapeHtml(data.businessName)}.</p>`,
        ),
        smsText: `You've reached ${data.tierName} status at ${data.businessName}! Congratulations.`,
      };
    case 'reward_redeemed':
      return {
        subject: `Reward confirmed: ${data.rewardName}`,
        emailHtml: wrap(
          `<p>Your redemption of <strong>${escapeHtml(data.rewardName)}</strong> at ${escapeHtml(data.businessName)} has been confirmed. Enjoy!</p>`,
        ),
        smsText: `Your redemption of ${data.rewardName} at ${data.businessName} is confirmed. Enjoy!`,
      };
    // No deep link into the thread in either of these -- there's no public
    // unauthenticated read path for a conversation, unlike e.g. a QR
    // feedback link, so both templates just point the recipient at signing
    // into the app rather than a URL.
    case 'message_received':
      return {
        subject: `New message from ${data.businessName}`,
        emailHtml: wrap(
          `<p>You have a new message from <strong>${escapeHtml(data.businessName)}</strong>:</p>` +
            `<p>"${escapeHtml(data.preview)}"</p>` +
            `<p>Sign in to your loyalty dashboard to read and reply.</p>`,
        ),
        smsText: `New message from ${data.businessName}: "${data.preview}" -- sign in to your loyalty dashboard to reply.`,
      };
    case 'message_reply_received':
      return {
        subject: `New reply from ${data.customerLabel}`,
        emailHtml: wrap(
          `<p>New reply from <strong>${escapeHtml(data.customerLabel)}</strong> at ${escapeHtml(data.businessName)}:</p>` +
            `<p>"${escapeHtml(data.preview)}"</p>` +
            `<p>Open the Messages tab in your dashboard to reply.</p>`,
        ),
        smsText: `New reply from ${data.customerLabel} at ${data.businessName}: "${data.preview}" -- check the Messages tab.`,
      };
  }
}
