import { describe, expect, it } from 'vitest';
import { canonicalRequest, signMessage, signRequest, verifyMessage, verifyRequest } from '../../src/protocol';
import { DELIVERY_KEY, RETRIEVAL_KEY, link } from '../helpers/email';

/**
 * Known-answer vectors. The MESSAGE vector was produced by the harness's own `signMessage` (apps/api/scripts/acceptance/cashier-02/adapters/spool-envelope.ts)
 * and is asserted there too, so a drift in either canonical form fails a test on BOTH sides.
 */
const MSG = { to: 'acc-abcd1234-main@acc-test.example', runId: 'abcd1234', receivedAtMs: 1700000000000, text: link() };
const MSG_MAC = '79335f05fd63a1ad9d888e6efeb5ca7b332583ffc38cd79c3976ddef163877d4';
const REQ = { method: 'POST', path: '/v1/claim', ts: '1700000000000', nonce: '0123456789abcdef0123456789abcdef', body: '{"recipient":"acc-abcd1234-main@acc-test.example","runId":"abcd1234"}' };
const REQ_MAC = '7fa4df7f7c3384b9a311c76ca90e42368dadc0ecd7152d24521bb19d51e1bed7';

describe('protocol known-answer vectors', () => {
  it('the delivered-message MAC equals the harness spool-envelope MAC', async () => {
    expect(await signMessage(DELIVERY_KEY, MSG)).toBe(MSG_MAC);
    expect(await verifyMessage(DELIVERY_KEY, { ...MSG, mac: MSG_MAC })).toBe(true);
  });
  it('the request MAC is stable', async () => {
    expect(await signRequest(RETRIEVAL_KEY, REQ)).toBe(REQ_MAC);
    expect(await verifyRequest(RETRIEVAL_KEY, REQ, REQ_MAC)).toBe(true);
  });
  it('every bound field matters', async () => {
    for (const change of [{ method: 'GET' }, { path: '/v1/other' }, { ts: '1700000000001' }, { nonce: 'f'.repeat(32) }, { body: '{}' }]) {
      expect(await verifyRequest(RETRIEVAL_KEY, { ...REQ, ...change }, REQ_MAC)).toBe(false);
    }
    for (const change of [{ to: 'acc-abcd1234-other@acc-test.example' }, { runId: 'zzzz9999' }, { receivedAtMs: 1 }, { text: 'x' }]) {
      expect(await verifyMessage(DELIVERY_KEY, { ...MSG, ...change, mac: MSG_MAC })).toBe(false);
    }
  });
  it('the two keys are not interchangeable', async () => {
    expect(await verifyRequest(DELIVERY_KEY, REQ, REQ_MAC)).toBe(false);
    expect(await verifyMessage(RETRIEVAL_KEY, { ...MSG, mac: MSG_MAC })).toBe(false);
  });
  it('rejects malformed MACs without throwing', async () => {
    for (const bad of ['', 'zz', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      expect(await verifyRequest(RETRIEVAL_KEY, REQ, bad)).toBe(false);
    }
  });
  it('the canonical request form is the documented one', async () => {
    expect((await canonicalRequest(REQ)).split('\n').slice(0, 5)).toEqual(['v1', 'POST', '/v1/claim', REQ.ts, REQ.nonce]);
  });
});
