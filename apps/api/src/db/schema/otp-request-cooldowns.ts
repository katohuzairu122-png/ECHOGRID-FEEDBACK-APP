import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One atomic reservation per phone number for OTP delivery. Keeping this
 * separate from otp_codes lets Postgres serialize concurrent requests with
 * INSERT ... ON CONFLICT, closing the cross-isolate read-then-create race
 * without retaining a plaintext code or holding a transaction open during
 * the SMS provider call.
 */
export const otpRequestCooldowns = pgTable('otp_request_cooldowns', {
  phone: text('phone').primaryKey(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
});

