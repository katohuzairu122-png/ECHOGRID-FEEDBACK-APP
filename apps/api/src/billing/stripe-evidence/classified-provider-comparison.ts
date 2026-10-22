import { classifyEnvelope, type ShapeDefect, type ParseStatus } from './shape';
import { compareProviderEventFields, type ProviderComparison } from './provider-fields';

/**
 * Typed, non-authoritative cross-provenance boundary.
 *
 * Callers must already have independently authenticated and durably captured
 * the webhook and securely retrieved the provider event. This helper does
 * neither, and cannot approve tenant identity, historical tier, settlement,
 * subscription authority or a financial posting.
 */
export type ClassifiedProvenanceComparison =
  | { status: 'unusable_envelope'; source: 'webhook' | 'retrieved'; parseStatus: ParseStatus; defects: readonly ShapeDefect[] }
  | ProviderComparison;

/** Accept JSON text, not caller-asserted WellFormedEnvelope instances. */
export function compareClassifiedProvenance(
  webhookJson: string,
  retrievedJson: string,
): ClassifiedProvenanceComparison {
  const webhook = classifyEnvelope(webhookJson);
  if (webhook.kind === 'malformed') {
    return {
      status: 'unusable_envelope',
      source: 'webhook',
      parseStatus: webhook.parseStatus,
      defects: webhook.defects,
    };
  }

  const retrieved = classifyEnvelope(retrievedJson);
  if (retrieved.kind === 'malformed') {
    return {
      status: 'unusable_envelope',
      source: 'retrieved',
      parseStatus: retrieved.parseStatus,
      defects: retrieved.defects,
    };
  }

  return compareProviderEventFields(webhook.envelope, retrieved.envelope);
}
