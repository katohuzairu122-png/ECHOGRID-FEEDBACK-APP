import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/** Offline Workers-runtime tests (real workerd, Durable Objects, no remote bindings). */
export default defineWorkersConfig({
  test: {
    include: ['test/workers/**/*.test.ts'],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            ALLOWED_RECIPIENT_DOMAIN: 'acc-test.example',
            ALLOWED_SENDER_DOMAINS: 'mail.sender.example',
            CONFIRMATION_LINK_HOSTS: 'web.staging.example',
            ACCEPTANCE_MAILBOX_DELIVERY_KEY: 'test-delivery-key-0123456789abcdef-0123456789',
            ACCEPTANCE_RECEIVER_RETRIEVAL_KEY: 'test-retrieval-key-fedcba9876543210-9876543210',
          },
        },
      },
    },
  },
});
