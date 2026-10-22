import type { WellFormedEnvelope } from './shape';

/**
 * HETA G2: a typed, deliberately narrow provider-event comparison.
 * This is a consistency signal ONLY, never a provider-identity, tenant-binding,
 * interval-completeness, historical-price, or financial-authorization certificate.
 *
 * Serialization and webhook-vs-retrieval bytes are intentionally excluded.
 * Unknown object IDs fail closed instead of being treated as equal nulls.
 */
export type StableField = 'event_id' | 'event_type' | 'event_created' | 'livemode' | 'event_account' | 'object_type' | 'object_id';
export interface ProviderFieldMismatch {
  field: StableField;
  webhook: string | number | boolean | null;
  retrieved: string | number | boolean | null;
}
export type ProviderComparison =
  | { status: 'matched'; mismatches: [] }
  | { status: 'mismatched'; mismatches: ProviderFieldMismatch[] }
  | { status: 'insufficient_evidence'; reasons: readonly ('missing_object_id' | 'missing_object_type')[] };

const scalar = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;

export function compareProviderEventFields(
  webhook: WellFormedEnvelope,
  retrieved: WellFormedEnvelope,
): ProviderComparison {
  const aType = scalar(webhook.dataObject.object);
  const bType = scalar(retrieved.dataObject.object);
  const aId = scalar(webhook.dataObject.id);
  const bId = scalar(retrieved.dataObject.id);
  const reasons: ('missing_object_id' | 'missing_object_type')[] = [];
  if (aType === null || bType === null) reasons.push('missing_object_type');
  if (aId === null || bId === null) reasons.push('missing_object_id');
  if (reasons.length > 0) return { status: 'insufficient_evidence', reasons };

  const fields: readonly [StableField, string | number | boolean | null, string | number | boolean | null][] = [
    ['event_id', webhook.id, retrieved.id],
    ['event_type', webhook.type, retrieved.type],
    ['event_created', webhook.created, retrieved.created],
    ['livemode', webhook.livemode, retrieved.livemode],
    ['event_account', webhook.account, retrieved.account],
    ['object_type', aType, bType],
    ['object_id', aId, bId],
  ];
  const mismatches: ProviderFieldMismatch[] = [];
  for (const [field, left, right] of fields) {
    if (left !== right) mismatches.push({ field, webhook: left, retrieved: right });
  }
  return mismatches.length > 0
    ? { status: 'mismatched', mismatches }
    : { status: 'matched', mismatches: [] };
}
