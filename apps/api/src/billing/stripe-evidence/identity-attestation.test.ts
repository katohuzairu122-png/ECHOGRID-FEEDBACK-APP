import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './signature';
import { reviewHistoricalEffectiveTimeAuthority } from '../../partner-credits/historical-effective-time-authority.review';

// Synthetic cryptographic evidence only. No proposed canonicalization/attestation validator.
const now = new Date('2099-01-01T00:00:00Z');
const timestamp = Math.floor(now.getTime() / 1000);
const secret = 'synthetic-block-f-signing-material';
const secrets = [{ label: 'synthetic-f', secret }];
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const header = (body: string) =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
const verify = (rawBody: string, signature: string | null) =>
  verifyWebhookSignature({ rawBody, header: signature, secrets, now });

describe('Block F representation integrity and non-authority', () => {
  it('different serializations can represent equal JSON but have different byte digests', () => {
    const webhook = '{"id":"evt_syntheticF","livemode":false}';
    const retrieved = '{ "livemode": false, "id": "evt_syntheticF" }';
    expect(JSON.parse(webhook)).toEqual(JSON.parse(retrieved));
    expect(digest(webhook)).not.toBe(digest(retrieved));
    // Equal parsed JSON is not a provider identity or completeness proof.
  });
  it('enforced: signed bytes cannot be replaced by reserialized API JSON', async () => {
    const webhook = '{"id":"evt_syntheticF","livemode":false}';
    const retrieved = JSON.stringify(JSON.parse(webhook), null, 2);
    expect((await verify(webhook, header(webhook))).ok).toBe(true);
    expect(await verify(retrieved, header(webhook))).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });
  it('enforced: API JSON without signature is not webhook-signature provenance', async () => {
    expect(await verify('{"id":"evt_syntheticF"}', null)).toEqual({
      ok: false,
      reason: 'MISSING_HEADER',
    });
  });
  it('characterization: authentic signed malformed bytes are not a valid event envelope', async () => {
    const malformed = '{synthetic-invalid-json';
    expect((await verify(malformed, header(malformed))).ok).toBe(true);
    expect(() => JSON.parse(malformed)).toThrow();
  });
  it.each([
    { account: 'acct_wrongSynthetic', livemode: false },
    { account: 'acct_connectedSynthetic', livemode: true },
  ])(
    'characterization: signature verification does not attest deployment account/mode %j',
    async (claims) => {
      const body = JSON.stringify({ id: 'evt_syntheticF', ...claims });
      const result = await verify(body, header(body));
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty('accountVerified');
      expect(result).not.toHaveProperty('historicalTierVerified');
    },
  );
  it.each(['evt_webhookSynthetic', 'evt_apiSynthetic', 'synthetic-attestation-passed'])(
    'enforced: self-reported complete evidence %s cannot authorize historical tier or issuance',
    (providerRef) => {
      const result = reviewHistoricalEffectiveTimeAuthority({
        businessId: 'synthetic-business',
        customerId: 'cus_synthetic',
        subscriptionId: 'sub_synthetic',
        fulfillmentAt: now,
        sources: [
          {
            kind: 'immutable_provider_transition_receipt',
            providerRef,
            effectiveAt: now,
            immutableCapture: true,
            completeFromSubscriptionInception: true,
          },
        ],
      });
      expect(result).toMatchObject({
        historicalTierVerified: false,
        issuanceAuthorized: false,
        reason: 'HISTORICAL_COMPLETENESS_UNPROVEN',
      });
    },
  );
});
