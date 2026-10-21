import { describe, it, expect } from 'vitest';
import {
  evaluateAttestation, sameEndpointUrl, eventsDigest, keyModeOf, isRestrictedKey, stripeObserver, ATTESTATION_VERIFIER, DEFAULT_REQUIRED_EVENT_TYPES,
  type AttestationExpectation, type AttestationObservation, type ObservedEndpoint, type AttestationFailure,
} from './attestation';

const URL_OK = 'https://api.example.com/webhooks/stripe';
const exp: AttestationExpectation = { accountId: 'acct_TESTACCT', livemode: false, endpointUrl: URL_OK, approvedApiVersions: ['2026-05-27.dahlia'], requiredEventTypes: [...DEFAULT_REQUIRED_EVENT_TYPES] };
const ep = (o: Partial<ObservedEndpoint> = {}): ObservedEndpoint => ({
  id: 'we_1', url: URL_OK, status: 'enabled', livemode: false, apiVersion: '2026-05-27.dahlia', enabledEvents: [...DEFAULT_REQUIRED_EVENT_TYPES, 'invoice.paid'], application: null, ...o,
});
const obs = (o: Partial<AttestationObservation> = {}, endpoints: ObservedEndpoint[] = [ep()], complete = true): AttestationObservation => ({
  accountId: 'acct_TESTACCT', keyLivemode: false, restrictedKey: true, listing: { complete, pages: 1, endpoints }, ...o,
});
const ctx = { commitSha: 'abc123', checkedAt: new Date('2026-10-20T00:00:00Z') };
const failures = (o: AttestationObservation, e = exp) => evaluateAttestation(e, o, ctx).failures;

describe('L2 attestation evaluation (B.2)', () => {
  it('passes only when every check holds, and records non-secret facts', () => {
    const r = evaluateAttestation(exp, obs(), ctx);
    expect(r.result).toBe('passed');
    expect(r.failures).toEqual([]);
    expect(r.details).toMatchObject({ result: 'passed', verifier: ATTESTATION_VERIFIER, commitSha: 'abc123', endpointId: 'we_1', observedAccountId: 'acct_TESTACCT', enabledEventsCount: 4 });
    expect(r.details.enabledEventsDigest).toBe(eventsDigest([...DEFAULT_REQUIRED_EVENT_TYPES, 'invoice.paid']));
    expect(JSON.stringify(r.details)).not.toMatch(/rk_|sk_|whsec_/);
  });

  it.each<[string, AttestationObservation, AttestationFailure]>([
    ['account mismatch', obs({ accountId: 'acct_OTHER' }), 'ACCOUNT_MISMATCH'],
    ['key mode mismatch', obs({ keyLivemode: true }), 'KEY_MODE_MISMATCH'],
    ['key mode unknown', obs({ keyLivemode: null }), 'KEY_MODE_UNKNOWN'],
    ['not a restricted key', obs({ restrictedKey: false }), 'RESTRICTED_KEY_REQUIRED'],
    ['incomplete listing', obs({}, [ep()], false), 'LISTING_INCOMPLETE'],
    ['no endpoint at the exact URL', obs({}, [ep({ url: 'https://api.example.com/webhooks/other' })]), 'ENDPOINT_NOT_FOUND'],
    ['URL differing only by query', obs({}, [ep({ url: URL_OK + '?x=1' })]), 'ENDPOINT_NOT_FOUND'],
    ['two endpoints at the URL', obs({}, [ep(), ep({ id: 'we_2' })]), 'ENDPOINT_AMBIGUOUS'],
    ['disabled endpoint', obs({}, [ep({ status: 'disabled' })]), 'ENDPOINT_DISABLED'],
    ['endpoint mode mismatch', obs({}, [ep({ livemode: true })]), 'ENDPOINT_MODE_MISMATCH'],
    ['unapproved API version', obs({}, [ep({ apiVersion: '2020-01-01' })]), 'API_VERSION_UNAPPROVED'],
    ['null (account default) API version', obs({}, [ep({ apiVersion: null })]), 'API_VERSION_UNAPPROVED'],
    ['missing a required event type', obs({}, [ep({ enabledEvents: ['customer.subscription.created'] })]), 'EVENTS_NOT_SUPERSET'],
    ['positive Connect evidence', obs({}, [ep({ application: 'ca_123' })]), 'ENDPOINT_NOT_DIRECT'],
    ['Stripe API error', obs({ accountId: null, listing: null, apiError: 'StripeConnectionError' }), 'STRIPE_API_ERROR'],
  ])('fails: %s', (_n, o, code) => {
    const r = evaluateAttestation(exp, o, ctx);
    expect(r.result).toBe('failed');
    expect(r.failures).toContain(code);
    expect(r.details.result).toBe('failed');
  });

  it('a wildcard enabled_events satisfies the required types', () => {
    expect(failures(obs({}, [ep({ enabledEvents: ['*'] })]))).toEqual([]);
  });

  it('the record of a Connect-unverifiable direct scope states its basis (P20 residual risk is explicit)', () => {
    expect(String(evaluateAttestation(exp, obs(), ctx).details.directScopeBasis)).toMatch(/P20/);
  });

  it.each([
    ['invalid account id', { ...exp, accountId: 'nope' }],
    ['http URL on a non-localhost host', { ...exp, endpointUrl: 'http://api.example.com/webhooks/stripe' }],
    ['URL with a query', { ...exp, endpointUrl: URL_OK + '?a=1' }],
    ['no approved versions', { ...exp, approvedApiVersions: [] }],
    ['no required event types', { ...exp, requiredEventTypes: [] }],
  ])('rejects an invalid expectation: %s', (_n, e) => {
    expect(failures(obs(), e)).toContain('EXPECTATION_INVALID');
  });

  it('exact URL identity ignores default ports and case in the host but nothing else', () => {
    expect(sameEndpointUrl('https://API.example.com:443/webhooks/stripe', URL_OK)).toBe(true);
    expect(sameEndpointUrl('https://api.example.com/webhooks/stripe/', URL_OK)).toBe(false);
    expect(sameEndpointUrl('http://api.example.com/webhooks/stripe', URL_OK)).toBe(false);
    expect(sameEndpointUrl('https://u:p@api.example.com/webhooks/stripe', URL_OK)).toBe(false);
    expect(sameEndpointUrl('not a url', URL_OK)).toBe(false);
  });

  it('derives the key mode from the prefix and refuses non-restricted keys without any network call', async () => {
    expect(keyModeOf('rk_live_x')).toBe(true);
    expect(keyModeOf('rk_test_x')).toBe(false);
    expect(keyModeOf('pk_test_x')).toBeNull();
    expect(isRestrictedKey('sk_test_x')).toBe(false);
    const o = await stripeObserver('sk_test_runtime_key_must_never_be_used')();
    expect(o).toMatchObject({ restrictedKey: false, accountId: null, listing: null });
    expect(failures(o)).toContain('RESTRICTED_KEY_REQUIRED');
  });

  it('the digest is order independent', () => {
    expect(eventsDigest(['b', 'a'])).toBe(eventsDigest(['a', 'b']));
    expect(eventsDigest(['a'])).not.toBe(eventsDigest(['a', 'b']));
  });
});
