import { describe, expect, it } from 'vitest';
import {
  B405_PROTOCOL,
  assessB405BrokerCompatibility,
  type B405ProposedBrokerContract,
} from './broker-protocol-conformance';

const ed = (): B405ProposedBrokerContract => ({
  version: B405_PROTOCOL.version,
  algorithm: B405_PROTOCOL.algorithm,
  environment: B405_PROTOCOL.environment,
  issuer: B405_PROTOCOL.issuer,
  audience: B405_PROTOCOL.audience,
  workloadId: B405_PROTOCOL.workloadId,
  actorType: B405_PROTOCOL.actorType,
  operation: B405_PROTOCOL.operation,
  permission: B405_PROTOCOL.permission,
  assertionFields: [...B405_PROTOCOL.issuerClaims],
  databaseVerifierCertified: false,
  trustedRuntimeCertified: false,
});

describe('Gate 2 B4-05 — static protocol gate; never grants broker access', () => {
  it('pins the B4-03 development-only Ed25519 protocol', () => {
    expect(B405_PROTOCOL.version).toBe('B4-03/1');
    expect(B405_PROTOCOL.algorithm).toBe('Ed25519');
    expect(B405_PROTOCOL.issuerClaims).toHaveLength(20);
    expect(B405_PROTOCOL.runtimeActivationPermitted).toBe(false);
    expect(B405_PROTOCOL.databaseVerificationReady).toBe(false);
  });

  it('rejects the B4-01/B4-02 HMAC assertion fixture', () => {
    expect(assessB405BrokerCompatibility({
      ...ed(), algorithm: 'HMAC-SHA256',
      assertionFields: ['kid','iss','aud','actor','sid','business','branch','action','nonce','request','iat','exp','sig'],
    })).toMatchObject({ compatible: false, reason: 'PROTOCOL_MISMATCH' });
  });

  it.each(['version','algorithm','environment','issuer','audience','workloadId','actorType','operation','permission'] as const)(
    'rejects altered %s without negotiation or downgrade',
    field => {
      expect(assessB405BrokerCompatibility({ ...ed(), [field]: 'other' }))
        .toMatchObject({ compatible: false, reason: 'PROTOCOL_MISMATCH' });
    },
  );

  it('rejects reordered, missing and duplicated fields', () => {
    const reordered = [...B405_PROTOCOL.issuerClaims].reverse();
    expect(assessB405BrokerCompatibility({ ...ed(), assertionFields: reordered }).reason).toBe('PROTOCOL_MISMATCH');
    expect(assessB405BrokerCompatibility({ ...ed(), assertionFields: reordered.slice(1) }).reason).toBe('PROTOCOL_MISMATCH');
    expect(assessB405BrokerCompatibility({ ...ed(), assertionFields: Array(20).fill('version') }).reason).toBe('PROTOCOL_MISMATCH');
  });

  it('does not confuse structurally correct assertions with database verification', () => {
    expect(assessB405BrokerCompatibility(ed())).toEqual({
      compatible: false, runtimeAuthorized: false, reason: 'NO_APPROVED_DB_VERIFIER',
    });
  });

  it('does not trust caller-supplied certification or runtime flags', () => {
    expect(assessB405BrokerCompatibility({
      ...ed(), databaseVerifierCertified: true, trustedRuntimeCertified: true,
    })).toEqual({ compatible: false, runtimeAuthorized: false, reason: 'NO_TRUSTED_RUNTIME' });
  });

  it.each([null, undefined, false, [], {}, 'B4-03/1', 1])(
    'rejects malformed contract %s',
    input => {
      expect(assessB405BrokerCompatibility(input))
        .toMatchObject({ compatible: false, runtimeAuthorized: false, reason: 'PROTOCOL_MISMATCH' });
    },
  );
});
