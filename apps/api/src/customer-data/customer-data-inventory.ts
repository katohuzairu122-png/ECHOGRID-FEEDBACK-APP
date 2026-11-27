import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

/**
 * G8 CUST-DEL-03 readiness (NON-DESTRUCTIVE). A reviewed inventory of EVERY table that holds a customer reference, so a deletion policy can be written and later executed against a
 * complete, machine-checked list (an integration test compares this list with the live database catalogue, so a new customer-linked table fails CI until it is classified here).
 * NOTHING is deleted, anonymised or changed by this module, and no treatment is invented: every entry's treatment is `UNDECIDED_REQUIRES_OWNER_POLICY` (retention, legal-hold and
 * anonymisation policies are Owner/legal decisions; the named privacy operator and approver do not exist yet).
 */
export const CUSTOMER_DATA_CATEGORIES = ['identity_authentication', 'relationship_consent', 'loyalty_financial_ledger', 'evidence_reference', 'tentaship_synthetic', 'governance_hold', 'communications_log'] as const;
export type CustomerDataCategory = (typeof CUSTOMER_DATA_CATEGORIES)[number];
export interface CustomerDataEntry { table: string; column: string; category: CustomerDataCategory; appendOnly: boolean; treatment: 'UNDECIDED_REQUIRES_OWNER_POLICY' }
const e = (table: string, column: string, category: CustomerDataCategory, appendOnly = false): CustomerDataEntry => ({ table, column, category, appendOnly, treatment: 'UNDECIDED_REQUIRES_OWNER_POLICY' });

export const CUSTOMER_DATA_INVENTORY: readonly CustomerDataEntry[] = [
  e('customer_credentials', 'customer_id', 'identity_authentication'), e('customer_sessions', 'customer_id', 'identity_authentication'), e('customer_auth_challenges', 'customer_id', 'identity_authentication'),
  e('customer_auth_events', 'customer_id', 'identity_authentication', true), e('customer_recovery_attempts', 'customer_id', 'identity_authentication', true), e('customer_recovery_code_sets', 'customer_id', 'identity_authentication'),
  e('customer_recovery_codes', 'customer_id', 'identity_authentication'), e('customer_action_authorizations', 'customer_id', 'identity_authentication'), e('customer_sanctions', 'customer_id', 'identity_authentication'),
  e('business_customer_memberships', 'customer_id', 'relationship_consent'), e('community_memberships', 'customer_id', 'relationship_consent'), e('network_follows', 'customer_id', 'relationship_consent'),
  e('conversations', 'customer_id', 'relationship_consent'), e('notification_preferences', 'customer_id', 'relationship_consent'), e('consent_grants', 'customer_id', 'relationship_consent'),
  e('loyalty_accounts', 'customer_id', 'loyalty_financial_ledger'), e('loyalty_accounts', 'referred_by_customer_id', 'loyalty_financial_ledger'), e('loyalty_purchase_events', 'customer_id', 'loyalty_financial_ledger', true),
  e('loyalty_program_progress', 'customer_id', 'loyalty_financial_ledger'), // LPC-01: per-account programme counters (stamps, streaks, missions); frozen, never deleted by the platform
  e('orphan_reward_claims', 'customer_id', 'loyalty_financial_ledger'), e('orphan_settlements', 'customer_id', 'loyalty_financial_ledger'), e('orphan_settlement_events', 'customer_id', 'loyalty_financial_ledger', true),
  e('community_point_accounts', 'customer_id', 'loyalty_financial_ledger'), e('community_point_award_decisions', 'customer_id', 'loyalty_financial_ledger', true), e('community_point_transactions', 'customer_id', 'loyalty_financial_ledger', true),
  e('customer_referrals', 'referred_customer_id', 'evidence_reference'), e('customer_referrals', 'referring_customer_id', 'evidence_reference'), e('customer_onboarding_events', 'customer_id', 'evidence_reference', true),
  e('network_engagement_events', 'customer_id', 'evidence_reference', true), e('survey_participations', 'participant_customer_id', 'evidence_reference'), e('community_pilot_eligibility_events', 'customer_id', 'evidence_reference', true),
  e('tentaship_badge_awards', 'customer_id', 'tentaship_synthetic'), e('shuffle_eligibility_snapshots', 'customer_id', 'tentaship_synthetic', true), e('shuffle_invitations', 'customer_id', 'tentaship_synthetic'),
  e('shuffle_entries', 'customer_id', 'tentaship_synthetic'), e('shuffle_notification_deliveries', 'customer_id', 'tentaship_synthetic', true), e('shuffle_drop_allocations', 'customer_id', 'tentaship_synthetic', true),
  e('drop_reservations', 'customer_id', 'tentaship_synthetic'),
  e('legal_holds', 'customer_id', 'governance_hold'), e('privacy_requests', 'customer_id', 'governance_hold'), e('customer_deletion_requests', 'customer_id', 'governance_hold'),
  e('notifications', 'customer_id', 'communications_log', true),
];

export const DELETION_EXECUTION_BLOCKERS = ['RETENTION_POLICY_NOT_APPROVED', 'LEGAL_HOLD_POLICY_NOT_APPROVED', 'ANONYMISATION_POLICY_NOT_APPROVED', 'NAMED_PRIVACY_OPERATOR_REQUIRED', 'NAMED_APPROVER_REQUIRED', 'MIGRATION_NOT_REVIEWED'] as const;

export interface CustomerDeletionReadiness {
  customerFound: boolean;
  /** Aggregate row counts per category (counts only; never identities or values). */
  holdings: Record<CustomerDataCategory, number>;
  appendOnlyRowsPresent: boolean;
  /** An existing legal hold (not released) is a fact the platform already records; its POLICY is still unapproved. */
  activeLegalHold: boolean;
  openDeletionRequest: boolean;
  execution: 'blocked';
  blockers: readonly (typeof DELETION_EXECUTION_BLOCKERS)[number][];
}

/** Read-only reconciliation of what exists for a customer. It cannot delete or change anything and always reports execution as blocked. */
export async function assessCustomerDeletionReadiness(db: Db, customerId: string): Promise<CustomerDeletionReadiness> {
  const found = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM customers WHERE id = ${customerId}`);
  const holdings = Object.fromEntries(CUSTOMER_DATA_CATEGORIES.map((c) => [c, 0])) as Record<CustomerDataCategory, number>;
  let appendOnlyRowsPresent = false;
  for (const entry of CUSTOMER_DATA_INVENTORY) {
    // identifiers come ONLY from the reviewed constant list above (never from input), so interpolation is safe
    const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(entry.table)} WHERE ${sql.identifier(entry.column)} = ${customerId}`);
    const n = Number(r.rows[0]?.n ?? 0); holdings[entry.category] += n; if (n > 0 && entry.appendOnly) appendOnlyRowsPresent = true;
  }
  const hold = await db.execute<{ ok: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM legal_holds WHERE customer_id = ${customerId} AND released_at IS NULL) AS ok`);
  const req = await db.execute<{ ok: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM customer_deletion_requests WHERE customer_id = ${customerId}) AS ok`);
  return { customerFound: Number(found.rows[0]?.n ?? 0) === 1, holdings, appendOnlyRowsPresent, activeLegalHold: hold.rows[0]?.ok === true, openDeletionRequest: req.rows[0]?.ok === true, execution: 'blocked', blockers: DELETION_EXECUTION_BLOCKERS };
}
