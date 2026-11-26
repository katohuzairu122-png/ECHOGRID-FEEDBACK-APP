import { z } from 'zod';
import { createHash } from 'node:crypto';

/**
 * TSH-01 section 4 / QUAL-PURCHASE-01: the CLOSED, declarative qualification rule shared by Tentaship Badges, Shuffle and Drops. DATA, never code:
 * a combinator (ANY, ALL, AT_LEAST n) over 1..8 pathways, each a metric from a closed registry with a whole-number threshold and optional bounded
 * parameters. No expressions, scripts, regular expressions or free text. Evaluation is a pure, deterministic function of (spec, measured evidence).
 *
 * NOTHING here approves a definition. A spec only matters once a rule VERSION holding it is `approved` (an Owner policy act this block does not
 * perform); until then no qualification can succeed in production. Amounts are exact decimal STRINGS compared in SQL `numeric`, never floats, and are
 * only meaningful together with a currency (different currencies are never compared).
 */
export const QUALIFICATION_METRICS = {
  /** Customer: cashier-RECORDED purchase events (payment_status confirmed). Evidence level is `recorded`, NOT independently settled payment. */
  recorded_purchases: 'customer',
  /** Customer: an attribution of this customer exists (any type permitted by the spec's referralTypes). */
  referral_attributed: 'customer',
} as const;
export type QualificationMetric = keyof typeof QUALIFICATION_METRICS;
export const EVIDENCE_LEVELS = ['recorded', 'verified_transaction', 'financially_settled'] as const;
/** The strongest level the platform can honestly claim today: purchases are entered by an authorised cashier; no external settlement evidence exists. */
export const MAX_PURCHASE_EVIDENCE_LEVEL = 'recorded' as const;

const DECIMAL = /^\d{1,12}(\.\d{1,2})?$/;
const pathwaySchema = z.object({
  metric: z.enum(['recorded_purchases', 'referral_attributed']),
  threshold: z.number().int().min(1).max(100_000),
  minAmount: z.string().regex(DECIMAL).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  windowDays: z.number().int().min(1).max(3650).optional(),
  /** Count only purchases at or after the referral attribution (for referral qualification). */
  sinceAttribution: z.boolean().optional(),
}).strict();

const specSchema = z.object({
  combinator: z.enum(['ANY', 'ALL', 'AT_LEAST']),
  atLeast: z.number().int().min(1).max(8).optional(),
  pathways: z.array(pathwaySchema).min(1).max(8),
  /** Which acquisition types may qualify. Defaults to customer referrals ONLY: a business invitation is never a customer referral unless a rule says so. */
  referralTypes: z.array(z.enum(['business_invitation', 'customer_referral'])).min(1).max(2).optional(),
}).strict();

export type QualificationPathway = z.infer<typeof pathwaySchema>;
export type QualificationSpec = z.infer<typeof specSchema>;

export class QualificationSpecError extends Error {
  constructor(message: string) { super(message); }
}

export function parseQualificationSpec(raw: unknown): QualificationSpec {
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) throw new QualificationSpecError('The rule must match the closed qualification schema (no extra fields).');
  const spec = parsed.data;
  if ((spec.combinator === 'AT_LEAST') !== (spec.atLeast !== undefined)) throw new QualificationSpecError('AT_LEAST needs atLeast, and atLeast needs AT_LEAST.');
  if (spec.atLeast !== undefined && spec.atLeast > spec.pathways.length) throw new QualificationSpecError('atLeast cannot exceed the number of pathways.');
  for (const p of spec.pathways) {
    if ((p.minAmount === undefined) !== (p.currency === undefined)) throw new QualificationSpecError('minAmount and currency go together (currencies are never compared).');
    if (p.metric !== 'recorded_purchases' && (p.minAmount !== undefined || p.sinceAttribution !== undefined)) throw new QualificationSpecError('This metric takes no amount or sinceAttribution.');
  }
  return spec;
}

export function canonicalSpecJson(spec: QualificationSpec): string {
  const clean = (v: unknown): unknown => Array.isArray(v) ? v.map(clean)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, clean(x)]))
      : v;
  return JSON.stringify(clean(spec));
}
export const hashSpec = (spec: QualificationSpec): string => createHash('sha256').update(canonicalSpecJson(spec)).digest('hex');

export type PathwayMeasure = { observed: number; evidenceIds: string[] };
export type QualificationOutcome = {
  qualified: boolean;
  pathways: Array<{ metric: QualificationMetric; threshold: number; observed: number; met: boolean }>;
  /** The evidence ids of every MET pathway: exactly what a qualification consumes. */
  evidenceIds: string[];
};

/** Pure and deterministic: the same spec and measures always give the same outcome. Missing measures count as nothing observed (fail closed). */
export function evaluateQualification(spec: QualificationSpec, measures: ReadonlyArray<PathwayMeasure | undefined>): QualificationOutcome {
  const pathways = spec.pathways.map((p, i) => {
    const m = measures[i];
    const observed = m ? Math.max(0, Math.floor(m.observed)) : 0;
    return { metric: p.metric, threshold: p.threshold, observed, met: observed >= p.threshold, ids: m && observed >= p.threshold ? m.evidenceIds : [] };
  });
  const metCount = pathways.filter((p) => p.met).length;
  const qualified = spec.combinator === 'ANY' ? metCount >= 1 : spec.combinator === 'ALL' ? metCount === pathways.length : metCount >= (spec.atLeast as number);
  const evidenceIds = qualified ? [...new Set(pathways.flatMap((p) => p.ids))].sort() : [];
  return { qualified, pathways: pathways.map(({ ids: _ids, ...rest }) => rest), evidenceIds };
}
