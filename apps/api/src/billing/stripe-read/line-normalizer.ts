import { RESERVATION_METADATA_KEY } from '../provider-effect.adapter';
import { collectPages, type PageRecord } from './pagination';
import { contradictory, unresolved, verified, type EvidenceOrigin, type Field, type MockLineAttribution, type NormalizedLine } from './evidence-types';
import type { ProviderProfile } from './provider-profiles';

/**
 * S08-D1D3-DEV-07: normalization of paged invoice-line evidence (`INVOICE_LINES_LIST`, NOT AUTHORIZED: this runs over test adapters and synthetic fixtures only).
 *
 * Shape (per the SDK profile; unproven live): line_item { id, object, amount, currency, invoice, livemode, metadata, parent{ type, invoice_item_details{ invoice_item, proration, subscription },
 * subscription_item_details{ invoice_item, proration, subscription, subscription_item } } }.
 *
 * Subscription lines (parent type subscription_item_details) are the recurring base (or proration). A negative line that comes from an Invoice Item may be our benefit line, but nothing in a
 * Stripe line proves it: the idempotency key of the parent item is not a field of the line or the item. That correlation must come from SEPARATE provider evidence
 * (`idempotency`), which does not exist for real reads. Without it the line stays an unattributed `other` line and the attribution is UNRESOLVED; with it, the line must match exactly one
 * frozen allocation by key and amount or it is a fabricated/contradictory benefit line. The metadata label is preserved for review and never trusted. Frozen allocations are only read.
 */
export interface FrozenReference { readonly reservationId: string; readonly providerIdempotencyKey: string; readonly benefitMinor: number }
export interface IdempotencyEvidence { readonly parentItemRef: string; readonly idempotencyKey: string }
export interface LineContext { readonly invoiceId: string; readonly currency: string; readonly totalMinor: number | null; readonly profile: ProviderProfile | null }
export interface LineOptions { readonly origin: EvidenceOrigin; readonly frozen: readonly FrozenReference[] | null; readonly idempotency: readonly IdempotencyEvidence[] | null }
export interface LineNormalization {
  readonly lines: Field<Readonly<{ items: readonly NormalizedLine[]; pageComplete: boolean }>>;
  readonly attribution: Field<readonly MockLineAttribution[]>;
  readonly drift: readonly string[];
}

const LINE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const CURRENCY = /^[a-z]{3}$/;
const REF = /^[A-Za-z0-9_-]{1,255}$/;
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

export function normalizeLinePages(pages: readonly PageRecord[] | null | undefined, ctx: LineContext, opts: LineOptions): LineNormalization {
  const both = (reason: string, kind: 'unresolved' | 'contradictory', drift: string[] = []): LineNormalization => ({
    lines: kind === 'unresolved' ? unresolved(reason) : contradictory(reason), attribution: kind === 'unresolved' ? unresolved(reason) : contradictory(reason), drift,
  });
  if (!ctx.profile || !ctx.profile.categories.includes('invoice_lines')) return both('API_VERSION_UNSUPPORTED', 'unresolved', ['API_VERSION_UNSUPPORTED:invoice_lines']);
  const collected = collectPages(pages, item => (isObj(item) && typeof item.id === 'string' && LINE_ID.test(item.id) ? item.id : null));
  if (collected.state !== 'COMPLETE') {
    return collected.state === 'CONTRADICTORY' ? both(collected.reason, 'contradictory') : both(collected.reason, 'unresolved', collected.state === 'MALFORMED' ? [`LINES_${collected.reason}`] : []);
  }

  const drift: string[] = []; const contradictions: string[] = []; const unproven: string[] = [];
  const items: NormalizedLine[] = []; const attribution: MockLineAttribution[] = [];
  const byRef = new Map<string, string>(); let idemConflict = false;
  for (const e of opts.idempotency ?? []) { if (byRef.has(e.parentItemRef) && byRef.get(e.parentItemRef) !== e.idempotencyKey) idemConflict = true; byRef.set(e.parentItemRef, e.idempotencyKey); }
  if (idemConflict) contradictions.push('IDEMPOTENCY_EVIDENCE_CONFLICT');
  const allocByKey = new Map((opts.frozen ?? []).map(f => [f.providerIdempotencyKey, f] as const));
  const benefitKeysSeen = new Set<string>();

  for (const raw of collected.items as Array<Record<string, unknown>>) {
    const id = raw.id as string;
    if (raw.object !== 'line_item') { drift.push('LINE_OBJECT'); continue; }
    if (!isInt(raw.amount)) { drift.push('LINE_AMOUNT'); continue; }
    if (typeof raw.currency !== 'string' || !CURRENCY.test(raw.currency)) { drift.push('LINE_CURRENCY'); continue; }
    if (typeof raw.invoice !== 'string') { drift.push('LINE_INVOICE_MISSING'); continue; }
    if (raw.invoice !== ctx.invoiceId) contradictions.push('LINE_FOR_OTHER_INVOICE');
    if (raw.livemode !== false) contradictions.push('LINE_LIVEMODE_NOT_TEST');
    if (raw.currency !== ctx.currency) contradictions.push('LINE_CURRENCY_MISMATCH');
    const metadataOk = raw.metadata === null || raw.metadata === undefined || (isObj(raw.metadata) && Object.values(raw.metadata).every(v => typeof v === 'string'));
    if (!metadataOk) { drift.push('METADATA_MALFORMED'); continue; }
    const label = isObj(raw.metadata) && typeof raw.metadata[RESERVATION_METADATA_KEY] === 'string' ? (raw.metadata[RESERVATION_METADATA_KEY] as string) : null;
    items.push({ lineRef: id, amountMinor: raw.amount, currency: raw.currency });

    const parent = isObj(raw.parent) ? raw.parent : null;
    const type = parent?.type;
    if (type === 'subscription_item_details' && isObj(parent!.subscription_item_details) && typeof (parent!.subscription_item_details as Record<string, unknown>).proration === 'boolean') {
      const d = parent!.subscription_item_details as Record<string, unknown>;
      attribution.push({ lineRef: id, category: d.proration === true ? 'proration' : 'recurring_base', parentItemRef: typeof d.invoice_item === 'string' && REF.test(d.invoice_item) ? d.invoice_item : null, parentItemKey: null, labelReservationRef: label });
      if (label !== null) contradictions.push('BENEFIT_LABEL_ON_SUBSCRIPTION_LINE'); // our label on a line that came from the subscription cannot be our benefit
    } else if (type === 'invoice_item_details' && isObj(parent!.invoice_item_details)) {
      const d = parent!.invoice_item_details as Record<string, unknown>;
      if (typeof d.invoice_item !== 'string' || !REF.test(d.invoice_item)) { unproven.push('PARENT_ITEM_MISSING'); attribution.push({ lineRef: id, category: 'other', parentItemRef: null, parentItemKey: null, labelReservationRef: label }); continue; }
      const key = byRef.get(d.invoice_item);
      if (raw.amount >= 0) {
        if (label !== null) contradictions.push('FABRICATED_BENEFIT_LINE'); // a benefit label on a charge cannot be a benefit
        attribution.push({ lineRef: id, category: 'other', parentItemRef: d.invoice_item, parentItemKey: key ?? null, labelReservationRef: label });
      } else if (key === undefined) {
        unproven.push(label !== null ? 'UNVERIFIABLE_BENEFIT_LINE' : 'BENEFIT_ATTRIBUTION_UNPROVEN');
        attribution.push({ lineRef: id, category: 'other', parentItemRef: d.invoice_item, parentItemKey: null, labelReservationRef: label });
      } else if (opts.frozen === null) {
        unproven.push('FROZEN_ALLOCATION_UNAVAILABLE');
        attribution.push({ lineRef: id, category: 'other', parentItemRef: d.invoice_item, parentItemKey: key, labelReservationRef: label });
      } else {
        const alloc = allocByKey.get(key);
        if (!alloc) contradictions.push('FABRICATED_BENEFIT_LINE');
        else if (raw.amount !== -alloc.benefitMinor) contradictions.push('BENEFIT_AMOUNT_MISMATCH');
        else if (label !== null && label !== alloc.reservationId) contradictions.push('BENEFIT_LABEL_MISMATCH');
        else if (benefitKeysSeen.has(key)) contradictions.push('DUPLICATE_EFFECT');
        benefitKeysSeen.add(key);
        attribution.push({ lineRef: id, category: 'benefit', parentItemRef: d.invoice_item, parentItemKey: key, labelReservationRef: label });
      }
    } else { drift.push('LINE_PARENT_SHAPE'); }
  }
  if (ctx.totalMinor !== null && drift.length === 0 && items.reduce((n, l) => n + l.amountMinor, 0) !== ctx.totalMinor) contradictions.push('LINES_TOTAL_MISMATCH');

  const uniq = (a: string[]) => [...new Set(a)];
  if (contradictions.length) { const r = uniq(contradictions).join(','); return { lines: contradictory(r), attribution: contradictory(r), drift: uniq(drift) }; }
  if (drift.length) return { lines: unresolved(`SCHEMA_DRIFT:${uniq(drift).join(',')}`), attribution: unresolved(`SCHEMA_DRIFT:${uniq(drift).join(',')}`), drift: uniq(drift) };
  return {
    lines: verified({ items, pageComplete: true }, opts.origin, 'PROVIDER_SCHEMA'),
    attribution: unproven.length ? unresolved<readonly MockLineAttribution[]>(uniq(unproven).join(',')) : verified<readonly MockLineAttribution[]>(attribution, opts.origin, 'PROVIDER_SCHEMA'),
    drift: [],
  };
}
