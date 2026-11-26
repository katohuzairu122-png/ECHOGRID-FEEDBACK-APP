/**
 * TSH-05 notification POLICY foundation for Tentaship campaigns. Pure and fail-closed: it decides whether a delivery MAY happen and never sends anything. The existing platform
 * notification services (NotificationService / EmailService) are reused for approved account-security and transactional messages and are NOT touched; this module only gates
 * the NEW Tentaship classes. Consent is never inferred: following a business, a loyalty or Community membership, accepting an invitation, registering or taking part in a
 * campaign is NOT marketing consent. Until the Owner approves a notification policy for a class, delivery of that class is blocked (held intents are preserved).
 */
export const NOTIFICATION_CLASSES = ['account_security', 'transactional', 'operational', 'marketing', 'campaign_invitation', 'allocation_notification', 'collection_reminder'] as const;
export type NotificationClass = (typeof NOTIFICATION_CLASSES)[number];
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Classes already governed by the existing approved platform behaviour: this module does not alter them and does not gate them. */
export const EXISTING_APPROVED_CLASSES: readonly NotificationClass[] = ['account_security', 'transactional'];
/** The NEW Tentaship classes: blocked until an approved policy exists for the class. */
export const TENTASHIP_CLASSES: readonly NotificationClass[] = ['campaign_invitation', 'allocation_notification', 'collection_reminder', 'marketing', 'operational'];

/** Owner-approved policy for one class: which channels it may use and whether recipient marketing consent is required. Empty by default (nothing approved). */
export interface ApprovedClassPolicy { class: NotificationClass; channels: readonly NotificationChannel[]; requiresMarketingConsent: boolean; templateVersion: string; approvedByOwner: true }
export type PolicyRegistry = ReadonlyMap<NotificationClass, ApprovedClassPolicy>;
export const EMPTY_POLICY_REGISTRY: PolicyRegistry = new Map();

export type BlockReason =
  | 'EXISTING_BEHAVIOUR_NOT_GATED_HERE' | 'POLICY_NOT_APPROVED' | 'CHANNEL_NOT_APPROVED_FOR_CLASS' | 'MARKETING_CONSENT_MISSING' | 'TEMPLATE_VERSION_MISMATCH'
  | 'EXPIRED' | 'CANCELLED' | 'DUPLICATE' | 'RECIPIENT_MISMATCH' | 'UNKNOWN_CLASS_OR_CHANNEL' | 'NOT_SYNTHETIC_PROVIDER';
export interface DeliveryIntent {
  intentId: string; recipientId: string; notificationClass: NotificationClass; channel: NotificationChannel; campaignVersionId: string | null; templateVersion: string;
  expiresAt: Date; cancelled: boolean; idempotencyKey: string;
}
export interface RecipientConsent { recipientId: string; marketing: boolean | undefined }
export type DeliveryDecision = { allowed: true; policy: ApprovedClassPolicy } | { allowed: false; reasons: BlockReason[] };

export function evaluateDelivery(i: DeliveryIntent, consent: RecipientConsent | null, registry: PolicyRegistry, ctx: { now: Date; alreadyDelivered: ReadonlySet<string> }): DeliveryDecision {
  const reasons: BlockReason[] = [];
  if (!(NOTIFICATION_CLASSES as readonly string[]).includes(i.notificationClass) || !(NOTIFICATION_CHANNELS as readonly string[]).includes(i.channel)) return { allowed: false, reasons: ['UNKNOWN_CLASS_OR_CHANNEL'] };
  if (EXISTING_APPROVED_CLASSES.includes(i.notificationClass)) return { allowed: false, reasons: ['EXISTING_BEHAVIOUR_NOT_GATED_HERE'] }; // send these through the existing services, never through this path
  if (i.cancelled) reasons.push('CANCELLED');
  if (!(i.expiresAt.getTime() > ctx.now.getTime())) reasons.push('EXPIRED');
  if (ctx.alreadyDelivered.has(i.idempotencyKey)) reasons.push('DUPLICATE');
  if (consent && consent.recipientId !== i.recipientId) reasons.push('RECIPIENT_MISMATCH');
  const policy = registry.get(i.notificationClass);
  if (!policy || policy.approvedByOwner !== true) reasons.push('POLICY_NOT_APPROVED');
  else {
    if (!policy.channels.includes(i.channel)) reasons.push('CHANNEL_NOT_APPROVED_FOR_CLASS');
    if (policy.templateVersion !== i.templateVersion) reasons.push('TEMPLATE_VERSION_MISMATCH');
    // consent is explicit and recorded for THIS recipient: absent, undefined or false all block; nothing else substitutes for it
    if (policy.requiresMarketingConsent && !(consent && consent.recipientId === i.recipientId && consent.marketing === true)) reasons.push('MARKETING_CONSENT_MISSING');
  }
  return reasons.length ? { allowed: false, reasons } : { allowed: true, policy: policy! };
}

/** A provider is injected; only providers that declare themselves synthetic are accepted in this block, so no real message can be sent through here. */
export interface DeliveryProvider { readonly channel: NotificationChannel; readonly synthetic: boolean; send(i: DeliveryIntent): Promise<{ providerMessageId: string }> }
export class MockDeliveryProvider implements DeliveryProvider {
  readonly synthetic = true; readonly sent: DeliveryIntent[] = []; constructor(readonly channel: NotificationChannel, private readonly failFirst = 0) {}
  private calls = 0;
  async send(i: DeliveryIntent) { this.calls++; if (this.calls <= this.failFirst) throw new Error('synthetic provider failure'); this.sent.push(i); return { providerMessageId: `mock-${this.channel}-${i.idempotencyKey}` }; }
}
export type DeliveryState = 'held' | 'delivered' | 'failed' | 'blocked';
export interface DeliveryRecord { intentId: string; state: DeliveryState; attempts: number; reasons: BlockReason[]; providerMessageId?: string; error?: string }

/**
 * Dispatch with retry safety: an idempotency key is delivered at most once; a failure is recorded and may be retried (attempts counted) without ever double-sending; every
 * blocked decision leaves the intent HELD. Providers must be synthetic here.
 */
export class TentashipNotificationDispatcher {
  private readonly delivered = new Set<string>(); readonly records = new Map<string, DeliveryRecord>();
  constructor(private readonly registry: PolicyRegistry, private readonly providers: readonly DeliveryProvider[], private readonly maxAttempts = 3) {}
  async dispatch(i: DeliveryIntent, consent: RecipientConsent | null, now: Date): Promise<DeliveryRecord> {
    const prior = this.records.get(i.intentId);
    if (prior?.state === 'delivered') return prior; // replay: the stored outcome, no second send
    const provider = this.providers.find((p) => p.channel === i.channel);
    if (provider && !provider.synthetic) return this.record(i, { state: 'blocked', reasons: ['NOT_SYNTHETIC_PROVIDER'] });
    const d = evaluateDelivery(i, consent, this.registry, { now, alreadyDelivered: this.delivered });
    if (!d.allowed) return this.record(i, { state: d.reasons.includes('POLICY_NOT_APPROVED') || d.reasons.includes('MARKETING_CONSENT_MISSING') ? 'held' : 'blocked', reasons: d.reasons });
    if (!provider) return this.record(i, { state: 'held', reasons: ['CHANNEL_NOT_APPROVED_FOR_CLASS'] });
    const attempts = (prior?.attempts ?? 0) + 1;
    if (attempts > this.maxAttempts) return this.record(i, { state: 'failed', reasons: [], attempts: prior?.attempts ?? 0, error: 'MAX_ATTEMPTS_REACHED' });
    try { const r = await provider.send(i); this.delivered.add(i.idempotencyKey); return this.record(i, { state: 'delivered', reasons: [], attempts, providerMessageId: r.providerMessageId }); }
    catch (e) { return this.record(i, { state: 'failed', reasons: [], attempts, error: (e as Error).message }); }
  }
  private record(i: DeliveryIntent, r: Partial<DeliveryRecord> & { state: DeliveryState; reasons: BlockReason[] }): DeliveryRecord {
    const rec: DeliveryRecord = { intentId: i.intentId, attempts: this.records.get(i.intentId)?.attempts ?? 0, ...r }; this.records.set(i.intentId, rec); return rec;
  }
}
