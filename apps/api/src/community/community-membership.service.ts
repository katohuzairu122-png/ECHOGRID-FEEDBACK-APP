import { CommunityMembershipControls, recordCommunityMembershipControl, type CommunityMembershipControlConfig } from './community-membership-controls';
import { assertCommunityPilotEligible, communityPilotAllows, communityPilotRequirement, type CommunityPilotControlConfig, type CommunityPilotRequirement } from './community-pilot-eligibility';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { customers, consentGrants } from '../db/schema';
import { createRepositories, type CommunityMembership, type CommunityPointAccount } from '../repositories';
import { AppError } from '../lib/errors';
import { assertVerifiedPhoneFor } from '../lib/customer-verification';
import { validateCommunityTermsAcceptance, hashCommunityTermsContent } from './community-terms-authority';
import { COMMUNITY_CONSENT_ACTION, communityConsentStale, communityRequestKey, databaseTermsAuthority, latestCommunityTransition, lockCommunityTerms, validCommunityConsent } from './community-consent.persistence';

export interface CommunityStatus { membership: CommunityMembership | null; account: CommunityPointAccount | null }
export interface JoinCommunityResult extends CommunityStatus {
  membership: CommunityMembership; account: CommunityPointAccount; created: boolean; reactivated: boolean;
  consent: { version: string; acceptedAt: string; transitionId: string };
}

export class CommunityMembershipService {
  private readonly controls: CommunityMembershipControls;
  private readonly pilot: CommunityPilotRequirement;
  constructor(private readonly db: Db, config: CommunityMembershipControlConfig & CommunityPilotControlConfig = {}) {
    this.controls = new CommunityMembershipControls(config);
    this.pilot = communityPilotRequirement(config);
  }

  async getStatus(customerId: string): Promise<CommunityStatus> {
    const repos = createRepositories(this.db);
    const [membership, account] = await Promise.all([repos.communityMemberships.findByCustomerId(customerId), repos.communityPointAccounts.findByCustomerId(customerId)]);
    return { membership: membership ?? null, account: account ?? null };
  }

  async getOffer(customerId: string, locale: string) {
    try {
      return await this.db.transaction(async (tx) => {
        await lockCommunityTerms(tx);
        const terms = await databaseTermsAuthority(tx).resolve(locale);
        await tx.execute(sql`select id from ${customers} where ${customers.id}=${customerId} for update`);
        const membership = await createRepositories(tx).communityMemberships.findByCustomerId(customerId);
        const previous = await latestCommunityTransition(tx, membership?.id);
        const operation = membership?.status === 'inactive' ? 'restore' as const : membership ? 'rejoin' as const : 'join' as const;
        const eligible = this.controls.available(operation) && (await communityPilotAllows(tx, customerId, this.pilot)) && !(await customerLifecycleBlocksActivation(tx, customerId));
        return { terms, transitionId: previous?.id ?? null, operation, activationAvailable: eligible };
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'COMMUNITY_TERMS_UNAVAILABLE') return null;
      throw error;
    }
  }

  /** One transaction, registry -> customer -> account. A legacy version string
   * is never acceptance, even when this service is called without an HTTP route. */
  async join(customerId: string, raw: unknown): Promise<JoinCommunityResult> {
    try {
    const result = await this.db.transaction(async (tx) => {
      await lockCommunityTerms(tx);
      await tx.execute(sql`select id from ${customers} where ${customers.id}=${customerId} for update`);
      const repos = createRepositories(tx);
      const customer = await repos.customers.findById(customerId);
      if (!customer || customer.status !== 'active') throw new AppError('Customer account is not available.', 409, 'CUSTOMER_NOT_AVAILABLE');
      assertVerifiedPhoneFor(customer, 'community');
      await assertCustomerLifecycleAllowsActivation(tx, customerId);
      let membership = await repos.communityMemberships.findByCustomerId(customerId);
      let account = await repos.communityPointAccounts.findByCustomerId(customerId);
      if (membership?.status === 'suspended' || account?.status === 'suspended') {
        throw new AppError('This Community membership cannot be reactivated by the customer.', 409, 'COMMUNITY_MEMBERSHIP_SUSPENDED');
      }
      const locale = raw && typeof raw === 'object' && 'displayedLocale' in raw ? String(raw.displayedLocale) : '';
      const terms = await databaseTermsAuthority(tx).resolve(locale || 'en');
      const previous = await latestCommunityTransition(tx, membership?.id);
      const basis = previous?.id ?? null;
      const operation = membership?.status === 'inactive' ? 'restore' as const : membership ? 'rejoin' as const : 'join' as const;
      const currentGrant = membership?.status === 'active' ? await validCommunityConsent(tx, customerId, membership.id, terms) : undefined;
      const expectedBasis = currentGrant ? (currentGrant.metadata?.previousTransitionId as string | null) : basis;
      const expectedOperation = currentGrant ? currentGrant.metadata?.operation as 'join' | 'rejoin' | 'restore' : operation;
      if (!['join', 'rejoin', 'restore'].includes(expectedOperation)) communityConsentStale();
      const permit = this.controls.authorize(tx, customerId, expectedOperation);
      const input = validateCommunityTermsAcceptance(raw, terms, { operation: expectedOperation, transitionId: expectedBasis });
      const key = await communityRequestKey(customerId, input.idempotencyKey);
      const fingerprint = await hashCommunityTermsContent(JSON.stringify([input.operation, terms.publicationId, terms.manifestHash, terms.contentHash, terms.locale, input.expectedTransitionId]));
      const [replay] = await tx.select().from(consentGrants).where(and(eq(consentGrants.customerId, customerId), eq(consentGrants.purpose, 'community_membership'), sql`${consentGrants.metadata}->>'requestKeyDigest'=${key}`)).limit(1);
      if (replay && (replay.customerId !== customerId || replay.metadata?.requestDigest !== fingerprint || replay.status !== 'active' || replay.metadata?.transitionId !== basis)) communityConsentStale();
      if (membership?.status === 'active') {
        if (!currentGrant || !account || account.status !== 'active' || currentGrant.metadata?.requestDigest !== fingerprint) communityConsentStale();
        return { membership, account, created: false, reactivated: false, consent: { version: currentGrant.consentVersion, acceptedAt: currentGrant.grantedAt.toISOString(), transitionId: String(currentGrant.metadata?.transitionId) } };
      }
      // An old request, even with a different key, must never resurrect a Leave.
      if (input.expectedTransitionId !== basis || replay) communityConsentStale();
      // Pilot eligibility is checked only where an activation would actually be written (an already-active replay returned above),
      // inside this transaction and under a shared per-customer lock, so a committed revoke is always honoured.
      await assertCommunityPilotEligible(tx, customerId, this.pilot);
      const created = !membership;
      const priorMembershipObservation = membership ? { status: membership.status, joinedAt: membership.joinedAt.toISOString(), policyVersion: membership.policyVersion } : null;
      const clock = await tx.execute<{ accepted_at: string }>(sql`select clock_timestamp()::text as accepted_at`);
      const acceptedAt = new Date(clock.rows[0]!.accepted_at);
      if (!membership) membership = await repos.communityMemberships.create({ customerId, status: 'active', policyVersion: terms.version, joinedAt: acceptedAt, leftAt: null, suspendedAt: null }, permit);
      else membership = await repos.communityMemberships.updateStatus(customerId, { status: 'active', policyVersion: terms.version, joinedAt: acceptedAt, leftAt: null, suspendedAt: null }, permit);
      if (!membership) throw new AppError('Community membership could not be activated.', 409, 'COMMUNITY_MEMBERSHIP_CONFLICT');
      if (!account) account = await repos.communityPointAccounts.create({ customerId, status: 'active', pointsBalance: 0 });
      else if (account.status !== 'active') account = await repos.communityPointAccounts.updateStatus(account.id, 'active');
      if (!account) throw new AppError('Community account could not be activated.', 409, 'COMMUNITY_ACCOUNT_CONFLICT');
      await tx.update(consentGrants).set({ status: 'revoked', revokedAt: acceptedAt }).where(and(eq(consentGrants.customerId, customerId), eq(consentGrants.purpose, 'community_membership'), eq(consentGrants.status, 'active')));
      const transitionId = crypto.randomUUID();
      const grantId = crypto.randomUUID();
      const metadata = { customerId, publicationId: terms.publicationId, version: terms.version, manifestHash: terms.manifestHash,
        artifactHash: terms.contentHash, locale: terms.locale, hashAlgorithm: terms.hashAlgorithm,
        transitionId, previousTransitionId: basis, operation: input.operation, requestDigest: fingerprint, requestKeyDigest: key };
      await repos.consentGrants.create({ id: grantId, customerId, businessId: null, purpose: 'community_membership', scope: 'community_membership',
        resourceType: 'community_membership', resourceId: membership.id, consentVersion: terms.version, status: 'active', grantedAt: acceptedAt, metadata });
      await repos.auditLog.recordReturningId({ id: transitionId, businessId: null, actorUserId: null, action: COMMUNITY_CONSENT_ACTION, entityType: 'community_membership', entityId: membership.id,
        metadata: { ...metadata, sequence: Number(previous?.metadata?.sequence ?? 0) + 1, priorMembershipObservation, consentAccepted: true, consentGrantId: grantId, acceptedAt: acceptedAt.toISOString(), auditCorrelationId: transitionId }, ipAddress: null, userAgent: null, createdAt: acceptedAt });
      return { membership, account, created, reactivated: !created, consent: { version: terms.version, acceptedAt: acceptedAt.toISOString(), transitionId } };
    });
    recordCommunityMembershipControl('activation', 'permitted');
    return result;
    } catch (error) {
      if (error instanceof AppError && error.code === 'COMMUNITY_PILOT_NOT_ELIGIBLE') {
        recordCommunityMembershipControl('activation', 'pilot_not_eligible');
      } else if (error instanceof AppError && error.code === 'COMMUNITY_ACCOUNT_DELETION_PENDING') {
        recordCommunityMembershipControl('activation', 'deletion_pending');
      } else if (!(error instanceof AppError && error.code === 'COMMUNITY_MEMBERSHIP_OPERATION_DISABLED')) {
        recordCommunityMembershipControl('activation', 'transition_failed');
      }
      throw error;
    }
  }

  /** Leave requires no terms service/schema and never deletes prior evidence. */
  async leave(customerId: string): Promise<CommunityStatus> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select id from ${customers} where ${customers.id}=${customerId} for update`);
      const repos = createRepositories(tx);
      const membership = await repos.communityMemberships.findByCustomerId(customerId);
      if (!membership) throw new AppError('Community membership not found.', 404, 'COMMUNITY_MEMBERSHIP_NOT_FOUND');
      if (membership.status === 'suspended') throw new AppError('A suspended Community membership cannot be changed by the customer.', 409, 'COMMUNITY_MEMBERSHIP_SUSPENDED');
      let updatedMembership = membership;
      if (membership.status !== 'left') {
        const row = await repos.communityMemberships.updateStatus(customerId, { status: 'left', leftAt: new Date() });
        if (!row) throw new AppError('Community membership could not be updated.', 409, 'COMMUNITY_MEMBERSHIP_CONFLICT');
        updatedMembership = row;
      }
      let account = await repos.communityPointAccounts.findByCustomerId(customerId);
      if (account && account.status !== 'closed') account = await repos.communityPointAccounts.updateStatus(account.id, 'closed');
      if (membership.status !== 'left') {
        await tx.update(consentGrants).set({ status: 'revoked', revokedAt: new Date() }).where(and(eq(consentGrants.customerId, customerId), eq(consentGrants.purpose, 'community_membership'), eq(consentGrants.status, 'active')));
        const previous = await latestCommunityTransition(tx, membership.id);
        const id = crypto.randomUUID();
        await repos.auditLog.recordReturningId({ id, businessId: null, actorUserId: null, action: COMMUNITY_CONSENT_ACTION, entityType: 'community_membership', entityId: membership.id,
          metadata: { customerId, sequence: Number(previous?.metadata?.sequence ?? 0) + 1, operation: 'leave', priorMembershipObservation: { status: membership.status, joinedAt: membership.joinedAt.toISOString(), policyVersion: membership.policyVersion }, previousTransitionId: previous?.id ?? null, auditCorrelationId: id, consentAccepted: false }, ipAddress: null, userAgent: null });
      }
      return { membership: updatedMembership, account: account ?? null };
    });
  }
}


/** CUST-DEL-01 x Community: a customer with a pending account-deletion request, or an anonymized customer shell, can never be (re)activated
 * in Community, whichever path reaches this service. Leaving and reads are unaffected. Nothing is erased here. */
async function customerLifecycleBlocksActivation(tx: Db, customerId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ blocked: boolean }>(sql`
    select (
      exists (select 1 from customer_deletion_requests where customer_id = ${customerId} and status = 'pending')
      or exists (select 1 from customers where id = ${customerId} and anonymized_at is not null)
    ) as blocked`);
  return rows[0]?.blocked === true;
}

async function assertCustomerLifecycleAllowsActivation(tx: Db, customerId: string): Promise<void> {
  if (await customerLifecycleBlocksActivation(tx, customerId)) {
    throw new AppError('This account cannot join Community while it is scheduled for deletion.', 409, 'COMMUNITY_ACCOUNT_DELETION_PENDING');
  }
}
