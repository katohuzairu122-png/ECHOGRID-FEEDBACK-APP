import { z } from 'zod';
/** Partner Credits are non-cash platform service-benefit units. Block 1 defines contracts only. */
export const partnerCreditUnitSchema = z.literal('partner_credit');
export const partnerCreditPolicySchema = z.object({
  version: z.string().min(1),
  awardUnits: z.literal(1),
  monthlyCap: z.literal(10),
  vestDays: z.literal(14),
  expiresAfterMonths: z.literal(12),
});
export const partnerCreditAccountSchema = z.object({
  businessId: z.uuid(), unit: partnerCreditUnitSchema,
  provisional: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  recoveryDue: z.number().int().nonnegative(),
});
export const partnerCreditAwardDecisionSchema = z.object({
  id: z.uuid(), settlementRef: z.uuid(), businessId: z.uuid(),
  policyVersion: z.string().min(1), awardUnits: z.number().int().nonnegative(),
  status: z.enum(['ineligible','cap_exceeded','provisional','vested','reversed']),
  earningMonthUtc: z.string().regex(/^\d{4}-\d{2}$/),
  fulfilledAt: z.string(), vestAt: z.string().nullable(),
});
/**
 * The Partner Credit ledger vocabulary, equal to the `partner_credit_ledger_type_check` constraint: the six original types (0040), `consume` and `consumed_reversal`
 * (D4, 0053) and the informational `reversal_noop` and `recovery_restored` (R10, 0058). An integration test pins this list to the live constraint.
 */
export const partnerCreditLedgerEntryTypes = [
  'provisional','vest','expire','reverse','recovery_offset','admin_adjustment',
  'consume','consumed_reversal','reversal_noop','recovery_restored',
] as const;
export const partnerCreditLedgerEntrySchema = z.object({
  id: z.uuid(), businessId: z.uuid(), accountId: z.uuid(),
  entryType: z.enum(partnerCreditLedgerEntryTypes),
  units: z.number().int().refine(n => n !== 0),
  idempotencyKey: z.string().min(1), occurredAt: z.string(),
});
export const partnerCreditRecoverySchema = z.object({
  reversalRef: z.uuid(), businessId: z.uuid(),
  unitsDue: z.number().int().positive(), unitsOutstanding: z.number().int().nonnegative(),
}).refine(v=>v.unitsOutstanding<=v.unitsDue);
export type PartnerCreditPolicy = z.infer<typeof partnerCreditPolicySchema>;
export type PartnerCreditAccount = z.infer<typeof partnerCreditAccountSchema>;
export type PartnerCreditAwardDecision = z.infer<typeof partnerCreditAwardDecisionSchema>;
export type PartnerCreditLedgerEntry = z.infer<typeof partnerCreditLedgerEntrySchema>;
