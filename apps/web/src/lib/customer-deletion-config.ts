import 'server-only';

/** Separate opt-in: email authentication alone never exposes deletion screens before migration 0089. */
export function isCustomerDeletionWebEnabled(): boolean {
  return process.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true' &&
    process.env.CUSTOMER_DELETION_ENABLED === 'true';
}
