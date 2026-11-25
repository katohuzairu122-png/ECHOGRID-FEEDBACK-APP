import type { JoinLoyaltyConsentVersion } from '@echo-grid-feedback/shared-types';
import type { Database } from '../db/client';
import { assertCustomerNotLimited } from '../lib/customer-limits';
import { createRepositories, type BusinessCustomerMembership, type LoyaltyAccount } from '../repositories';
import { AppError } from '../lib/errors';
import { isUniqueViolation } from '../lib/pg-errors';
import { assertVerifiedPhone } from '../lib/customer-verification';
import { endActiveMembership, lockCustomerBusinessRelationship } from './membership-lifecycle';
import { recordBusinessInvitationAttribution } from '../qualification/referral.service';
import { assertOwnerInvitationUsable } from '../customer-invitations/customer-invitation.service';
import { assertInviteCashierAuthorized, readVerificationState, type JoinAttribution } from './onboarding-attribution';

export interface JoinCustomerMembershipInput {
  customerId: string;
  businessId: string;
  onboardingSource: string;
  onboardingReference: string;
  /**
   * The JOIN_LOYALTY consent wording the customer explicitly accepted. Required,
   * so no caller can create a membership and a consent grant without naming the
   * text that was shown. Routes obtain it only after the request schema has
   * confirmed `consentAccepted: true`; the service never defaults it.
   */
  consentVersion: JoinLoyaltyConsentVersion;
  idempotencyKey?: string;
  /**
   * CASHIER-AUTH-02D: where this onboarding happened. Both public join routes always supply it, derived on the server (never from
   * the request body). When omitted, no onboarding event is recorded: callers must not invent one.
   */
  attribution?: JoinAttribution;
}

export interface JoinCustomerMembershipResult {
  membership: BusinessCustomerMembership;
  loyaltyAccount: LoyaltyAccount;
}

/** Unique indexes a join can still collide on once concurrent joins are serialised. */
const INVITE_ONCE_CONSTRAINTS = ['customer_onboarding_events_invite_once_key', 'customer_onboarding_events_remote_invite_once_key'] as const;
const JOIN_RACE_CONSTRAINTS = [
  'business_customer_memberships_customer_business_key',
  'loyalty_accounts_membership_id_key',
] as const;
/** Covers soft-deleted rows too, so it fires when a closed account blocks a new one. */
const LOYALTY_ACCOUNT_PAIR_CONSTRAINT = 'loyalty_accounts_customer_business_key';

/** Turns the two unique-violation shapes a join can still hit into deliberate 409s
 * instead of a generic 500; every other failure is returned untouched. */
function translateJoinError(error: unknown): unknown {
  if (isUniqueViolation(error, INVITE_ONCE_CONSTRAINTS)) {
    return new AppError('This invitation has already been used. Ask the cashier for a new one.', 409, 'ONBOARDING_INVITE_USED');
  }
  if (isUniqueViolation(error, [LOYALTY_ACCOUNT_PAIR_CONSTRAINT])) {
    return new AppError(
      'This loyalty account is closed. Please contact the business.',
      409,
      'LOYALTY_ACCOUNT_UNAVAILABLE',
    );
  }
  if (isUniqueViolation(error, JOIN_RACE_CONSTRAINTS)) {
    return new AppError(
      'Your enrollment is already being processed. Please try again.',
      409,
      'MEMBERSHIP_JOIN_CONFLICT',
    );
  }
  return error;
}

export class CustomerMembershipService {
  constructor(private readonly db: Database) {}

  /** Idempotent: joining a business you already belong to returns the existing membership and account. */
  async join(input: JoinCustomerMembershipInput): Promise<JoinCustomerMembershipResult> {
    try {
      return await this.joinSerialized(input);
    } catch (error) {
      throw translateJoinError(error);
    }
  }

  private async joinSerialized(input: JoinCustomerMembershipInput): Promise<JoinCustomerMembershipResult> {
    return this.db.transaction(async (tx) => {
      // Serialise concurrent joins of the same customer to the same business (a double-tap, a retry racing
      // the original request). Without this, both calls read "no membership", both insert, and the loser
      // fails on the unique index with a 500 -- or, when a membership already exists, both create a consent
      // grant. The lock is released when this transaction ends, so the second call then sees the first
      // call's committed rows and returns them. It is the same lock leaving and consent withdrawal take, so
      // a join can never interleave with either. Same pattern as business/branch name serialisation.
      await lockCustomerBusinessRelationship(tx, input.customerId, input.businessId);
      const repos = createRepositories(tx);
      const business = await repos.businesses.findById(input.businessId);
      if (!business || business.status !== 'active') {
        throw new AppError('This business is not available for loyalty enrollment.', 409, 'BUSINESS_NOT_AVAILABLE');
      }

      let membership = await repos.customerMemberships.findByCustomerAndBusiness(input.customerId, input.businessId);
      // Limited customers keep what they already belong to but cannot join anything new.
      if (!membership || membership.status !== 'active') {
        await assertCustomerNotLimited(repos, input.customerId, 'join_business');
        // The first business is open to everyone. Joining an ADDITIONAL business needs a verified phone; the check
        // is against any other membership row (left ones included) so leaving and re-joining cannot bypass it.
        const existing = await repos.customerMemberships.listForCustomer(input.customerId);
        if (existing.some((m) => m.businessId !== input.businessId)) {
          await assertVerifiedPhone(repos, input.customerId, 'join_additional_business');
        }
      }
      // A join is a NEW onboarding occurrence only when it creates the membership or brings a left one back; an idempotent retry of
      // an already-active membership records nothing, so a duplicate request can never add a second event.
      const isNewOccurrence = !membership || membership.status !== 'active';
      const isRejoin = Boolean(membership);
      if (isNewOccurrence && input.attribution?.source === 'cashier_assisted') {
        // Takes the shared lock on the cashier's live, still-bound session BEFORE anything is written (see onboarding-attribution.ts).
        await assertInviteCashierAuthorized(tx, {
          cashierUserId: input.attribution.cashier.userId, sessionId: input.attribution.cashier.sessionId,
          businessId: input.businessId, branchId: input.attribution.branchId,
        });
      }
      if (isNewOccurrence && input.attribution?.source === 'remote_invitation') {
        // OWNER-INVITE-01: shared lock on the invitation row BEFORE anything is written, so a concurrent revocation cannot slip between check and use.
        await assertOwnerInvitationUsable(tx, { invitationId: input.attribution.reference, businessId: input.businessId, branchId: input.attribution.branchId });
      }
      if (!membership) {
        membership = await repos.customerMemberships.create({
          customerId: input.customerId,
          businessId: input.businessId,
          status: 'active',
          onboardingSource: input.onboardingSource,
          onboardingReference: input.onboardingReference,
        });
      } else if (membership.status !== 'active') {
        if (membership.status !== 'left') {
          throw new AppError('This membership cannot be reactivated by the customer.', 409, 'MEMBERSHIP_NOT_REACTIVATABLE');
        }
        membership = await repos.customerMemberships.reactivate(
          membership.id,
          input.onboardingSource,
          input.onboardingReference,
        );
      }

      const existingJoinConsent = await repos.consentGrants.findActive(
        input.customerId,
        input.businessId,
        'join_loyalty',
      );
      let joinConsentId: string | undefined = existingJoinConsent?.id;
      if (!existingJoinConsent) {
        const grant = await repos.consentGrants.create({
          customerId: input.customerId,
          businessId: input.businessId,
          purpose: 'join_loyalty',
          consentVersion: input.consentVersion,
          status: 'active',
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          metadata: {
            onboardingSource: input.onboardingSource,
            onboardingReference: input.onboardingReference,
            membershipId: membership.id,
          },
        });
        // An idempotency key resolves to the grant it first created. If the customer has since withdrawn that
        // consent, replaying the old request must not quietly bring the membership back without a live consent;
        // the client has to ask again with a new key. Throwing rolls back the reactivation above.
        if (grant.status !== 'active') {
          throw new AppError('Consent idempotency key is already in use.', 409, 'CONSENT_IDEMPOTENCY_CONFLICT');
        }
        joinConsentId = grant.id;
      }

      let loyaltyAccount = await repos.loyaltyAccounts.findByCustomerAndBusiness(input.customerId, input.businessId);
      if (!loyaltyAccount) {
        loyaltyAccount = await repos.loyaltyAccounts.create({
          customerId: input.customerId,
          businessId: input.businessId,
          membershipId: membership.id,
        });
      } else if (!loyaltyAccount.membershipId) {
        loyaltyAccount = await repos.loyaltyAccounts.attachMembership(loyaltyAccount.id, membership.id);
      } else if (loyaltyAccount.membershipId !== membership.id) {
        throw new AppError('Loyalty membership mapping is inconsistent.', 409, 'MEMBERSHIP_MAPPING_CONFLICT');
      }

      if (isNewOccurrence && input.attribution) {
        // Same transaction as the membership and consent writes: either the join and its history both commit, or neither does.
        // The membership row's own onboarding_* summary columns keep describing the CURRENT relationship; this row is the history.
        const eventId = crypto.randomUUID();
        const occurredAt = new Date();
        const attribution = input.attribution;
        const verificationState = await readVerificationState(tx, input.customerId);
        const auditLogId = await repos.auditLog.recordReturningId({
          businessId: input.businessId,
          actorUserId: attribution.source === 'cashier_assisted' ? attribution.cashier.userId : null,
          action: 'customer.onboarded',
          entityType: 'customer_onboarding_event',
          entityId: eventId,
          // D2-FINAL forward minimization: the audit row names the EVENT (entity_id) but no longer embeds the membership id. The personal link
          // lives only in the erasable event row, so an erased event cannot be re-linked to a customer through audit metadata. No reader needs it.
          metadata: {
            source: attribution.source, branchId: attribution.branchId, rejoin: isRejoin,
            verificationState,
          },
        });
        await repos.customerOnboardingEvents.append({
          id: eventId,
          membershipId: membership.id,
          businessId: input.businessId,
          customerId: input.customerId,
          branchId: attribution.branchId,
          cashierUserId: attribution.source === 'cashier_assisted' ? attribution.cashier.userId : null,
          source: attribution.source,
          verificationState,
          ...(joinConsentId !== undefined ? { consentGrantId: joinConsentId } : {}),
          reference: attribution.reference,
          isRejoin,
          occurredAt,
          auditLogId,
        });
        // TSH-02: an invitation acceptance is recorded as a BUSINESS INVITATION attribution (an acquisition channel, never a customer referral).
        // Idempotent and once per customer ever; it awards nothing.
        if (attribution.source === 'remote_invitation' || attribution.source === 'cashier_assisted') {
          await recordBusinessInvitationAttribution(tx, {
            customerId: input.customerId, businessId: input.businessId,
            provenanceKind: attribution.source === 'remote_invitation' ? 'owner_invitation' : 'cashier_assisted_invitation', provenanceRef: attribution.reference,
          });
        }
      }

      return { membership, loyaltyAccount };
    });
  }

  /**
   * The customer ends their own membership. The loyalty program no longer
   * earns or redeems for them and the consent they gave to join is withdrawn,
   * but the loyalty account and its points balance are kept: joining again
   * (with fresh consent) restores them.
   *
   * Idempotent: leaving a membership that is already `left` returns it
   * unchanged. Only an active membership can be left; a suspended, pending or
   * closed one is the business's or the platform's to resolve, not the
   * customer's.
   */
  async leave(customerId: string, businessId: string): Promise<BusinessCustomerMembership> {
    return this.db.transaction(async (tx) => {
      await lockCustomerBusinessRelationship(tx, customerId, businessId);
      const repos = createRepositories(tx);

      const membership = await repos.customerMemberships.findByCustomerAndBusiness(customerId, businessId);
      if (!membership) {
        throw new AppError('Membership not found.', 404, 'CUSTOMER_MEMBERSHIP_NOT_FOUND');
      }
      if (membership.status === 'left') return membership;

      const left =
        membership.status === 'active' ? await endActiveMembership(repos, membership) : undefined;
      if (!left) {
        throw new AppError('This membership cannot be left by the customer.', 409, 'MEMBERSHIP_NOT_LEAVABLE');
      }
      return left;
    });
  }
}
