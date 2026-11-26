/**
 * G3 display-only DTOs for the contained sponsor-application and governance-case components. Every field is a RECORDED server value; nothing here lets a client decide, approve, override or
 * change anything. Anything outside the documented shape parses to `unavailable` (never an invented success).
 */
export const SPONSOR_STATUSES = ['submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'suspended', 'revoked'] as const;
export type SponsorStatus = (typeof SPONSOR_STATUSES)[number];
export type SponsorApplicationResult = { state: 'ready'; application: { status: SponsorStatus; reason: string | null; changedAt: string } } | { state: 'unavailable' };

export const CASE_KINDS = ['fraud', 'dispute'] as const;
export const CASE_STATUSES = ['open', 'escalated', 'under_review', 'decided', 'closed'] as const;
export const CASE_DECISIONS = ['upheld', 'overturned', 'no_action'] as const;
export type CaseChain = 'ok' | 'broken' | 'unknown';
export interface GovernanceCaseDto { kind: (typeof CASE_KINDS)[number]; status: (typeof CASE_STATUSES)[number]; decision: (typeof CASE_DECISIONS)[number] | null; evidenceCount: number; policyVersion: number | null; chain: CaseChain }
export type GovernanceCaseResult = { state: 'ready'; case: GovernanceCaseDto } | { state: 'unavailable' };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);

export function parseSponsorApplication(raw: unknown): SponsorApplicationResult {
  if (!isRecord(raw) || !oneOf(raw.status, SPONSOR_STATUSES) || typeof raw.changedAt !== 'string' || Number.isNaN(Date.parse(raw.changedAt)) || !(raw.reason === null || typeof raw.reason === 'string')) return { state: 'unavailable' };
  return { state: 'ready', application: { status: raw.status, reason: raw.reason, changedAt: raw.changedAt } };
}

export function parseGovernanceCase(raw: unknown): GovernanceCaseResult {
  if (!isRecord(raw) || !oneOf(raw.kind, CASE_KINDS) || !oneOf(raw.status, CASE_STATUSES) || !(raw.decision === null || oneOf(raw.decision, CASE_DECISIONS))
    || !Number.isInteger(raw.evidenceCount) || (raw.evidenceCount as number) < 0 || !(raw.policyVersion === null || (Number.isInteger(raw.policyVersion) && (raw.policyVersion as number) >= 1)) || !oneOf(raw.chain, ['ok', 'broken', 'unknown'] as const)) return { state: 'unavailable' };
  return { state: 'ready', case: { kind: raw.kind, status: raw.status, decision: raw.decision as GovernanceCaseDto['decision'], evidenceCount: raw.evidenceCount as number, policyVersion: raw.policyVersion as number | null, chain: raw.chain } };
}
