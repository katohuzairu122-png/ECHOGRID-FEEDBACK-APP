import { describe, expect, it } from 'vitest';
import { loadConfig, type Env } from '../../src/config';
import { DELIVERY_KEY, DOMAIN, RETRIEVAL_KEY, SENDER, WEB } from '../helpers/email';

const good = (): Env =>
  ({
    RECEIVER_ENVIRONMENT: 'acceptance-test',
    ALLOWED_RECIPIENT_DOMAIN: DOMAIN,
    ALLOWED_SENDER_DOMAINS: SENDER,
    CONFIRMATION_LINK_HOSTS: WEB,
    ACCEPTANCE_MAILBOX_DELIVERY_KEY: DELIVERY_KEY,
    ACCEPTANCE_RECEIVER_RETRIEVAL_KEY: RETRIEVAL_KEY,
  }) as unknown as Env;

describe('receiver configuration fails closed', () => {
  it('accepts a complete configuration', () => {
    const cfg = loadConfig(good());
    expect(cfg?.recipientDomain).toBe(DOMAIN);
    expect(cfg?.maxRawBytes).toBe(256 * 1024);
  });
  it.each([
    ['not marked as test infrastructure', { RECEIVER_ENVIRONMENT: 'production' }],
    ['environment missing', { RECEIVER_ENVIRONMENT: undefined }],
    ['no recipient domain (the shipped placeholder)', { ALLOWED_RECIPIENT_DOMAIN: '' }],
    ['recipient domain is not a domain', { ALLOWED_RECIPIENT_DOMAIN: 'localhost' }],
    ['recipient domain has a wildcard', { ALLOWED_RECIPIENT_DOMAIN: '*.acc-test.example' }],
    ['recipient domain has a path', { ALLOWED_RECIPIENT_DOMAIN: 'acc-test.example/x' }],
    ['no sender domain', { ALLOWED_SENDER_DOMAINS: '' }],
    ['no link host', { CONFIRMATION_LINK_HOSTS: '' }],
    ['recipient domain equals a sender domain', { ALLOWED_SENDER_DOMAINS: DOMAIN }],
    ['recipient domain equals a link host', { CONFIRMATION_LINK_HOSTS: DOMAIN }],
    ['delivery key missing', { ACCEPTANCE_MAILBOX_DELIVERY_KEY: undefined }],
    ['delivery key too short', { ACCEPTANCE_MAILBOX_DELIVERY_KEY: 'short' }],
    ['retrieval key too short', { ACCEPTANCE_RECEIVER_RETRIEVAL_KEY: 'x'.repeat(31) }],
    ['the two keys are the same', { ACCEPTANCE_RECEIVER_RETRIEVAL_KEY: DELIVERY_KEY }],
    ['size limit absurd', { MAX_RAW_BYTES: '999999999' }],
    ['size limit not a number', { MAX_RAW_BYTES: 'abc' }],
    ['ingest limit zero', { INGEST_LIMIT_PER_10_MIN: '0' }],
  ])('refuses: %s', (_name, patch) => {
    expect(loadConfig({ ...good(), ...patch } as Env)).toBeNull();
  });
});
