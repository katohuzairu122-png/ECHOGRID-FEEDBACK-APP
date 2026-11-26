/**
 * TDP-04 sponsor-report DTO (display only). Parses the API's aggregate analytics payload strictly: a figure is a number OR `{ available:false, reason }` and is NEVER
 * coerced to zero; any other shape is `unavailable`. No customer, reservation or staff identity, no revenue, return or acquisition field exists in this type.
 */
export type ReportMetric = number | { available: false; reason: string };
export const REPORT_STATUSES = ['draft', 'submitted', 'under_review', 'approved', 'scheduled', 'available', 'suspended', 'cancelled', 'expired'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export interface ReportMetrics {
  total: ReportMetric; available: ReportMetric; reserved: ReportMetric; allocated: ReportMetric; collected: ReportMetric; allocationsExpired: ReportMetric;
  reservationsCreated: ReportMetric; holdsReleased: ReportMetric; holdsExpired: ReportMetric; outstandingCollection: ReportMetric; collectionCompletionRate: ReportMetric; reconciled: boolean;
}
export type SponsorshipReportResult = { state: 'ready'; status: ReportStatus; metrics: ReportMetrics } | { state: 'no_inventory'; status: ReportStatus } | { state: 'unavailable' };
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isMetric = (v: unknown): v is ReportMetric => (typeof v === 'number' && Number.isFinite(v) && v >= 0) || (isRecord(v) && v.available === false && typeof v.reason === 'string');
const KEYS = ['total', 'available', 'reserved', 'allocated', 'collected', 'allocationsExpired', 'reservationsCreated', 'holdsReleased', 'holdsExpired', 'outstandingCollection', 'collectionCompletionRate'] as const;

export function parseSponsorshipReport(raw: unknown): SponsorshipReportResult {
  if (!isRecord(raw) || typeof raw.status !== 'string' || !(REPORT_STATUSES as readonly string[]).includes(raw.status)) return { state: 'unavailable' };
  const status = raw.status as ReportStatus;
  if (raw.metrics === null && raw.reason === 'NO_INVENTORY_UNTIL_APPROVED') return { state: 'no_inventory', status };
  if (!isRecord(raw.metrics) || typeof raw.metrics.reconciled !== 'boolean') return { state: 'unavailable' };
  const m = raw.metrics; const out: Record<string, unknown> = { reconciled: m.reconciled };
  for (const k of KEYS) { if (!isMetric(m[k])) return { state: 'unavailable' }; out[k] = m[k]; }
  return { state: 'ready', status, metrics: out as unknown as ReportMetrics };
}
export const reasonKey = (reason: string): 'NO_ALLOCATION_YET' | 'SUPPRESSED_SMALL_GROUP' | 'NOT_SUPPORTED_BY_EVIDENCE' | 'other' =>
  reason === 'NO_ALLOCATION_YET' || reason === 'SUPPRESSED_SMALL_GROUP' || reason === 'NOT_SUPPORTED_BY_EVIDENCE' ? reason : 'other';
