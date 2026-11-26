import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { shuffleInvitations, shuffleNotificationDeliveries, shuffleNotificationIntents } from '../db/schema';
import { AppError } from '../lib/errors';
import { evaluateDelivery, type BlockReason, type DeliveryIntent, type DeliveryProvider, type NotificationChannel, type PolicyRegistry, type RecipientConsent } from './tentaship-notification-policy';

/** The template version a Shuffle invitation notification is written against. An Owner-approved class policy must name exactly this version, or the message is blocked (TEMPLATE_VERSION_MISMATCH). */
export const SHUFFLE_INVITATION_TEMPLATE_VERSION = 'shuffle_invitation_v1';
export const DEFAULT_MAX_ATTEMPTS = 3;
const CANCELLING_INVITATION_STATUSES = ['withdrawn', 'declined'] as const;

export type DeliveryOutcome = { intentId: string; state: 'held' | 'blocked' | 'delivered' | 'failed'; attempt: number; reasons: string[]; replayed: boolean; providerMessageId?: string | undefined };

/**
 * G2: persistence-backed delivery of a held Shuffle notification intent, REUSING the existing class/channel/consent policy (evaluateDelivery) and provider contract; no second
 * notification system. Recipient binding = the invitation's customer (database-enforced); cancellation = the invitation was withdrawn or declined; expiry = the invitation's expiry;
 * marketing consent is NEVER inferred (only an explicit RecipientConsent passed in counts). With the default empty policy registry every call records `held` (POLICY_NOT_APPROVED) and
 * nothing is sent. Providers must declare themselves synthetic, so a real message cannot be sent through this path. Retry-safe: a delivered intent is replayed, never re-sent;
 * identical held/blocked decisions are not re-recorded; failures are retried up to a maximum.
 */
export class ShuffleNotificationDeliveryService {
  constructor(private readonly db: Db, private readonly registry: PolicyRegistry, private readonly providers: readonly DeliveryProvider[], private readonly maxAttempts = DEFAULT_MAX_ATTEMPTS) {}

  history(intentId: string) { return this.db.select().from(shuffleNotificationDeliveries).where(eq(shuffleNotificationDeliveries.intentId, intentId)).orderBy(asc(shuffleNotificationDeliveries.attempt)); }

  async dispatch(intentId: string, consent: RecipientConsent | null, now: Date = new Date()): Promise<DeliveryOutcome> {
    const [row] = await this.db.select({ intent: shuffleNotificationIntents, inv: shuffleInvitations }).from(shuffleNotificationIntents)
      .innerJoin(shuffleInvitations, eq(shuffleInvitations.id, shuffleNotificationIntents.invitationId)).where(eq(shuffleNotificationIntents.id, intentId)).limit(1);
    if (!row) throw new AppError('Notification intent not found.', 404, 'INTENT_NOT_FOUND');
    const prior = await this.history(intentId); const last = prior[prior.length - 1];
    const delivered = prior.find((p) => p.state === 'delivered');
    if (delivered) return { intentId, state: 'delivered', attempt: delivered.attempt, reasons: [], replayed: true, providerMessageId: delivered.providerMessageId ?? undefined };

    const channel = row.intent.channel as NotificationChannel;
    const di: DeliveryIntent = {
      intentId, recipientId: row.inv.customerId, notificationClass: 'campaign_invitation', channel, campaignVersionId: row.inv.campaignVersionId, templateVersion: SHUFFLE_INVITATION_TEMPLATE_VERSION,
      expiresAt: row.inv.expiresAt, cancelled: (CANCELLING_INVITATION_STATUSES as readonly string[]).includes(row.inv.status), idempotencyKey: `shuffle_intent:${intentId}`,
    };
    const provider = this.providers.find((p) => p.channel === channel);
    let state: DeliveryOutcome['state']; let reasons: string[] = []; let providerMessageId: string | undefined; let error: string | undefined;
    if (provider && !provider.synthetic) { state = 'blocked'; reasons = ['NOT_SYNTHETIC_PROVIDER']; }
    else {
      const d = evaluateDelivery(di, consent, this.registry, { now, alreadyDelivered: new Set() });
      if (!d.allowed) { reasons = d.reasons; state = d.reasons.includes('POLICY_NOT_APPROVED') || d.reasons.includes('MARKETING_CONSENT_MISSING') ? 'held' : 'blocked'; }
      else if (!provider) { state = 'held'; reasons = ['CHANNEL_NOT_APPROVED_FOR_CLASS' satisfies BlockReason]; }
      else if (prior.filter((p) => p.state === 'failed').length >= this.maxAttempts) { state = 'failed'; error = 'MAX_ATTEMPTS_REACHED'; }
      else {
        try { providerMessageId = (await provider.send(di)).providerMessageId; state = 'delivered'; } catch (e) { state = 'failed'; error = (e as Error).message; }
      }
    }
    // identical held/blocked decisions are not re-recorded, and the exhausted-retries outcome is stable
    if (last && last.state === state && (state === 'held' || state === 'blocked' || error === 'MAX_ATTEMPTS_REACHED') && JSON.stringify(last.reasons) === JSON.stringify(reasons) && (last.error ?? undefined) === error) {
      return { intentId, state, attempt: last.attempt, reasons, replayed: true };
    }
    const attempt = (last?.attempt ?? 0) + 1;
    await this.db.insert(shuffleNotificationDeliveries).values({
      intentId, customerId: row.inv.customerId, notificationClass: di.notificationClass, channel, templateVersion: di.templateVersion, attempt, state, reasons, providerMessageId: providerMessageId ?? null, error: error ?? null,
    });
    return { intentId, state, attempt, reasons, replayed: false, providerMessageId };
  }
}
