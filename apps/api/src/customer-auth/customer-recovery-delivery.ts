import type { EmailService } from '../notifications/email.service';
import type { SmsService } from './sms.service';
import { TwilioVerifyService, type TwilioVerifyCredentials } from './twilio-verify.service';
import type { RegistrationProofDelivery } from './customer-email-auth.service';
import type { RecoveryNoticeKind, RecoveryNotifier, RecoveryPhoneOtp } from './customer-recovery-attempt.service';

/**
 * CUSTOMER-AUTH-S4-03: delivery adapters for account recovery, built on the EXISTING
 * email (`EmailService`), SMS (`SmsService`) and phone-verification (`TwilioVerifyService`)
 * abstractions. Nothing here creates a binding or reads a secret: the caller supplies the
 * already-constructed services.
 *
 * Rules enforced here:
 *  - a notice NEVER contains a recovery code, an OTP or a password. Only the initiation and
 *    hold emails carry the cancellation credential, as a link FRAGMENT (not sent to servers or
 *    referrers, not in access logs);
 *  - SMS notices carry no link and no token;
 *  - "accepted" means the provider accepted the message, NOT that it was delivered. A provider
 *    error is reported as `failed`, which the orchestrator treats as fail closed;
 *  - the adapters never log a message, recipient or token.
 */

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const base = (webBaseUrl: string) => webBaseUrl.replace(/\/+$/, '');

/** One opaque credential, `<attemptId>.<token>`, in the URL fragment. */
export function buildRecoveryCancelLink(webBaseUrl: string, attemptId: string, cancelToken: string): string {
  return `${base(webBaseUrl)}/account/recovery/cancel#c=${encodeURIComponent(`${attemptId}.${cancelToken}`)}`;
}

export function buildRecoveryEmailChallengeLink(webBaseUrl: string, challengeId: string, proof: string): string {
  return `${base(webBaseUrl)}/account/recovery/email#c=${encodeURIComponent(`${challengeId}.${proof}`)}`;
}

type Rendered = { subject: string; html: string; sms: string };

export function renderRecoveryNotice(
  kind: RecoveryNoticeKind,
  input: { cancelLink?: string; holdUntil?: Date },
): Rendered {
  const wrap = (heading: string, paragraphs: string[]) =>
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827;">` +
    `<p style="font-size:20px;font-weight:700;margin:0 0 16px;">Echo Grid</p>` +
    `<h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(heading)}</h1>` +
    paragraphs.map((p) => `<p style="font-size:14px;line-height:1.5;margin:0 0 12px;">${p}</p>`).join('') + `</div>`;
  const cancel = input.cancelLink
    ? `<a href="${escapeHtml(input.cancelLink)}" style="color:#059669;">Cancel this recovery</a>`
    : '';
  switch (kind) {
    case 'initiated':
      return {
        subject: 'Account recovery started on your Echo Grid account',
        html: wrap('Account recovery started', [
          'Someone started the process to reset the password of your Echo Grid account.',
          'If this was you, continue in the app. If it was not you, cancel it now: ' + cancel,
          'We will never ask you for a recovery code or a one-time code by email or text message.',
        ]),
        sms: 'Echo Grid: account recovery was started on your account. If this was not you, use the cancel link we emailed you.',
      };
    case 'hold_started': {
      const until = input.holdUntil ? input.holdUntil.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'in 24 hours';
      return {
        subject: 'Your Echo Grid account recovery is on a 24-hour security hold',
        html: wrap('Security hold started', [
          `For your protection this recovery cannot finish before ${escapeHtml(until)}.`,
          'If this was not you, cancel it now: ' + cancel,
        ]),
        sms: 'Echo Grid: a recovery on your account is on a 24-hour security hold. If this was not you, use the cancel link we emailed you.',
      };
    }
    case 'cancelled':
      return {
        subject: 'Your Echo Grid account recovery was cancelled',
        html: wrap('Recovery cancelled', ['The account recovery on your Echo Grid account was cancelled. Your password was not changed.']),
        sms: 'Echo Grid: the account recovery on your account was cancelled. Your password was not changed.',
      };
    case 'completed':
      return {
        subject: 'Your Echo Grid password was reset',
        html: wrap('Password reset', [
          'The password of your Echo Grid account was reset and every signed-in device was signed out.',
          'If this was not you, contact support immediately.',
        ]),
        sms: 'Echo Grid: your account password was reset and all devices were signed out. If this was not you, contact support now.',
      };
  }
}

export function createRecoveryNotifier(config: {
  email: EmailService;
  /** Optional: SMS goes only to a VERIFIED phone and never fails the notice on its own. */
  sms?: SmsService;
  webBaseUrl: string;
}): RecoveryNotifier {
  return async (notice) => {
    const rendered = renderRecoveryNotice(notice.kind, {
      ...(notice.cancelToken ? { cancelLink: buildRecoveryCancelLink(config.webBaseUrl, notice.attemptId, notice.cancelToken) } : {}),
      ...(notice.holdUntil ? { holdUntil: notice.holdUntil } : {}),
    });
    let email: 'accepted' | 'failed' = 'failed';
    try {
      await config.email.send({ to: notice.recipients.email, subject: rendered.subject, html: rendered.html });
      email = 'accepted';
    } catch { /* reported as failed; the orchestrator fails closed */ }
    let phone: 'accepted' | 'failed' | 'skipped' = 'skipped';
    if (notice.recipients.phone && config.sms) {
      try { await config.sms.send(notice.recipients.phone, rendered.sms); phone = 'accepted'; } catch { phone = 'failed'; }
    }
    return { email, phone };
  };
}

/** Delivers the email-challenge link to the customer's own verified login email. */
export function createRecoveryEmailChallengeDelivery(config: { email: EmailService; webBaseUrl: string }): RegistrationProofDelivery {
  return async ({ recipient, challengeId, proof }) => {
    const link = buildRecoveryEmailChallengeLink(config.webBaseUrl, challengeId, proof);
    await config.email.send({
      to: recipient,
      subject: 'Confirm your email to continue Echo Grid account recovery',
      html:
        `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827;">` +
        `<p style="font-size:14px;line-height:1.5;">Use this link to confirm your email address and continue recovering your Echo Grid account. It expires in 15 minutes.</p>` +
        `<p><a href="${escapeHtml(link)}" style="color:#059669;">Confirm email</a></p>` +
        `<p style="font-size:13px;color:#6b7280;">If you did not ask for this, ignore this email and consider cancelling the recovery from the earlier notice.</p></div>`,
    });
  };
}

/** The recovery phone-OTP port over the existing Twilio Verify service (no new credentials). */
export function createRecoveryPhoneOtp(credentials: TwilioVerifyCredentials): RecoveryPhoneOtp {
  const verify = new TwilioVerifyService(credentials);
  return { send: (phone) => verify.request(phone), check: (phone, code) => verify.check(phone, code) };
}
