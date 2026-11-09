import { describe, expect, it } from 'vitest';
import {
  B407_VERIFIER_CANDIDATES,
  evaluateB407VerifierProvider,
} from './broker-verifier-provider-decision';

describe('Gate 2 B4-07 — verifier provider choice never creates runtime authority', () => {
  it('lists all provider candidates as unapproved', () => {
    expect(Object.keys(B407_VERIFIER_CANDIDATES)).toEqual([
      'pgcrypto', 'pgSessionJwt', 'pgjwt', 'independentBrokerService',
    ]);
    for (const item of Object.values(B407_VERIFIER_CANDIDATES)) {
      expect(item.liveApproved).toBe(false);
      expect(item.dbEd25519Certified).toBe(false);
      expect(item.claimIntegrityCertified).toBe(false);
    }
  });

  it('rejects mutable pg_session_jwt claims fallback without a configured JWK', () => {
    expect(evaluateB407VerifierProvider('pgSessionJwt')).toEqual({
      authorized: false, brokerEnabled: false, reason: 'CLAIMS_FALLBACK_UNTRUSTED',
    });
    expect(evaluateB407VerifierProvider('pgSessionJwt', { jwkConfigured: false, verified: true }))
      .toMatchObject({ authorized: false, reason: 'CLAIMS_FALLBACK_UNTRUSTED' });
  });

  it('does not confuse configured JWT JWKs with B4-03 detached signature verification', () => {
    expect(evaluateB407VerifierProvider('pgSessionJwt', { jwkConfigured: true, verified: true, certified: true }))
      .toEqual({
        authorized: false, brokerEnabled: false, reason: 'DETACHED_SIGNATURE_NOT_VERIFIED_IN_DB',
      });
  });

  it('denies HMAC/PGJWT candidates even when they claim verification', () => {
    for (const provider of ['pgcrypto','pgjwt']) {
      expect(evaluateB407VerifierProvider(provider, { verified: true, certified: true }))
        .toMatchObject({ authorized: false, brokerEnabled: false, reason: 'DETACHED_SIGNATURE_NOT_VERIFIED_IN_DB' });
    }
  });

  it('does not grant authority merely because independent verifier service is proposed', () => {
    expect(evaluateB407VerifierProvider('independentBrokerService', { verified: true, certified: true }))
      .toEqual({
        authorized: false, brokerEnabled: false, reason: 'INDEPENDENT_BROKER_NOT_CERTIFIED',
      });
  });

  it.each([undefined,null,0,false,{},[],'no-such-extension','Ed25519'])(
    'rejects unknown provider %s',
    candidate => {
      expect(evaluateB407VerifierProvider(candidate)).toEqual({
        authorized: false, brokerEnabled: false, reason: 'UNKNOWN_PROVIDER',
      });
    },
  );
});
