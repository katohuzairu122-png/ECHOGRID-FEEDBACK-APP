import { z } from 'zod';

export const customerMembershipStatusSchema = z.enum([
  'pending',
  'active',
  'suspended',
  'left',
  'business_exited',
  'closed',
]);

export const customerMembershipSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  businessId: z.uuid(),
  status: customerMembershipStatusSchema,
  joinedAt: z.string(),
  onboardingSource: z.string().nullable(),
  onboardingReference: z.string().nullable(),
});

/**
 * JOIN_LOYALTY consent wordings that have shipped. The version stored on a
 * consent grant says which text the customer saw, so only versions that map to
 * a real wording are accepted. A new wording gets a new entry here, in the web
 * message files and in CURRENT_JOIN_LOYALTY_CONSENT_VERSION, API first.
 */
export const JOIN_LOYALTY_CONSENT_VERSIONS = ['v1'] as const;
export type JoinLoyaltyConsentVersion = (typeof JOIN_LOYALTY_CONSENT_VERSIONS)[number];
export const CURRENT_JOIN_LOYALTY_CONSENT_VERSION: JoinLoyaltyConsentVersion = 'v1';

export const joinCustomerMembershipSchema = z.object({
  qrToken: z.string().min(1),
  /** Literally `true`: the customer ticked the consent box. A join is never accepted without it. */
  consentAccepted: z.literal(true),
  consentVersion: z.enum(JOIN_LOYALTY_CONSENT_VERSIONS).default(CURRENT_JOIN_LOYALTY_CONSENT_VERSION),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export type CustomerMembershipDto = z.infer<typeof customerMembershipSchema>;
export type JoinCustomerMembershipInput = z.infer<typeof joinCustomerMembershipSchema>;
