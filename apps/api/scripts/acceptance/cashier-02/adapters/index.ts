import type { MessageSourceFactory } from '../verification-mailbox';
import { createReceiverSource } from './cloudflare-receiver';
import { createLocalSpoolSource } from './local-spool';

/**
 * The mailbox adapters available in THIS build, by the name the committed configuration (`mailbox.adapter`) must use.
 * Two adapters ship: the provider-neutral local spool, and the receiver-backed "cloudflare-receiver" (E2D; talks only to the owner-approved test receiver host). A further provider adapter (for example one reading a dedicated test inbox) is added here only after the owner
 * approves that provider, its credentials and its recipient domain; see CASHIER_AUTH_02E_E2_MAILBOX_AND_READINESS.md for why the platform's existing
 * mail provider cannot simply be read back.
 */
export const MAILBOX_ADAPTERS: Readonly<Record<string, MessageSourceFactory>> = {
  'local-spool': createLocalSpoolSource,
  'cloudflare-receiver': (env, config) => createReceiverSource(env, config),
};
