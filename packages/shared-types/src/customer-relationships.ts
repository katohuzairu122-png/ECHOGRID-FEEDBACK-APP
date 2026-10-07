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

export const joinCustomerMembershipSchema = z.object({
  qrToken: z.string().min(1),
  consentVersion: z.string().trim().min(1).max(50).default('v1'),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

export type CustomerMembershipDto = z.infer<typeof customerMembershipSchema>;
export type JoinCustomerMembershipInput = z.infer<typeof joinCustomerMembershipSchema>;
