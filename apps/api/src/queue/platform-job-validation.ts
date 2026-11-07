import type { PlatformJob } from '../config/env';
import { notificationEventTypeSchema } from '@echo-grid-feedback/shared-types';

// Queue producers serialize Date values with toISOString() (UTC Z, zero or
// three millisecond digits). Date.parse alone normalizes impossible dates
// (e.g. February 30) and also accepts non-ISO inputs, so it is not enough.
const UTC_TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?Z$/;
const validDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !UTC_TIMESTAMP.test(v)) return false;
  const parsed = Date.parse(v);
  if (!Number.isFinite(parsed)) return false;
  const canonical = v.includes('.') ? v : v.replace(/Z$/, '.000Z');
  return new Date(parsed).toISOString() === canonical;
};
const QUEUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const validId = (v: unknown): v is string => typeof v === 'string' && QUEUE_ID.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (v: Record<string,unknown>, keys: readonly string[]) => Object.keys(v).every(k=>keys.includes(k));
const optionalId = (v: unknown) => v === undefined || validId(v);
const optionalText = (v: unknown) => v === undefined || (typeof v === 'string' && v.length <= 10000);
const validRecipientAddress = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 2048 &&
  v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);

/**
 * Validates untrusted queue JSON before any domain service or provider call.
 * Does not grant authorization; business ownership is checked downstream.
 */
export function isPlatformJob(value: unknown): value is PlatformJob {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'classify_feedback':
      return hasKeys(value,['type','feedbackId','businessId']) && validId(value.feedbackId) && validId(value.businessId);
    case 'generate_summary':
      return hasKeys(value,['type','businessId','branchId','periodType','periodStart','periodEnd']) &&
        validId(value.businessId) && optionalId(value.branchId) &&
        ['daily','weekly','monthly'].includes(String(value.periodType)) &&
        validDate(value.periodStart) && validDate(value.periodEnd) &&
        Date.parse(value.periodStart as string) < Date.parse(value.periodEnd as string);
    case 'send_notification':
      return hasKeys(value,['type','businessId','userId','customerId','eventType','channel','recipientAddress','subject','body']) &&
        validId(value.businessId) && optionalId(value.userId) && optionalId(value.customerId) &&
        notificationEventTypeSchema.safeParse(value.eventType).success && ['email','sms'].includes(String(value.channel)) &&
        validRecipientAddress(value.recipientAddress) &&
        optionalText(value.subject) && typeof value.body === 'string' && value.body.length <= 100000;
    case 'escalate_critical_incident':
      return hasKeys(value,['type','incidentId','businessId']) && validId(value.incidentId) && validId(value.businessId);
    default:
      return false;
  }
}
