/** B4-03 DEVELOPMENT wire contract. Not compatible with the B4-02 HMAC fixture.
 * Signature validity alone grants neither broker execution nor financial authority.
 * No production issuer, database verifier or credential provisioning is provided.
 */
export const BROKER_ISSUER = 'echogrid:development:b4-03';
export const BROKER_AUDIENCE = 'echogrid:development:branch-broker';
export const BROKER_WORKLOAD = 'echogrid:development:staff-issuer';
export const BROKER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface BrokerAssertionClaims {
  readonly version: 'B4-03/1'; readonly algorithm: 'Ed25519'; readonly environment: 'development';
  readonly issuer: typeof BROKER_ISSUER; readonly audience: typeof BROKER_AUDIENCE; readonly workloadId: typeof BROKER_WORKLOAD;
  readonly keyId: string; readonly keyVersion: number; readonly actorType: 'staff';
  readonly actorId: string; readonly sessionId: string; readonly businessId: string; readonly branchId: string;
  readonly operation: 'branches:read'; readonly permission: 'branches:view';
  readonly requestId: string; readonly nonce: string; readonly issuedAt: number; readonly expiresAt: number;
  /** Existing account/session/RBAC tables have no coordinated revocation epoch. Never fabricate one. */
  readonly authorizationVersion: null;
}
export interface BrokerAssertion { readonly claims: BrokerAssertionClaims; readonly signature: string }
export interface BrokerVerificationKey {
  readonly keyId: string; readonly version: number; readonly publicKeyHex: string;
  readonly state: 'ACTIVE' | 'REVOKED'; readonly notBefore: number; readonly notAfter: number;
}
export type BrokerKeySource = () => Promise<BrokerVerificationKey | null>;
const FIELDS: readonly (keyof BrokerAssertionClaims)[] = ['version', 'algorithm', 'environment', 'issuer', 'audience', 'workloadId', 'keyId', 'keyVersion', 'actorType',
  'actorId', 'sessionId', 'businessId', 'branchId', 'operation', 'permission', 'requestId', 'nonce', 'issuedAt', 'expiresAt', 'authorizationVersion'];
const int = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
export const brokerHex = (x: Uint8Array): string => Array.from(x, b => b.toString(16).padStart(2, '0')).join('');
const bytes = (x: string): Uint8Array => Uint8Array.from(x.match(/../g)!, s => parseInt(s, 16));
/** Domain-separated, fixed-order, UTF-8 byte-length prefixed fields. */
export function brokerAssertionMessage(c: BrokerAssertionClaims): Uint8Array {
  return new TextEncoder().encode(['ECHO-GRID:BROKER-ASSERTION:B4-03/1', ...FIELDS.map(f => String(c[f]))]
    .map(s => `${new TextEncoder().encode(s).length}:${s};`).join(''));
}
export function validBrokerKey(k: BrokerVerificationKey | null, now: number): k is BrokerVerificationKey {
  return !!k && typeof k.keyId === 'string' && typeof k.publicKeyHex === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(k.keyId) && int(k.version) && k.version > 0 &&
    /^[0-9a-f]{64}$/.test(k.publicKeyHex) && k.state === 'ACTIVE' && int(now) && int(k.notBefore) && int(k.notAfter) &&
    k.notBefore <= now && now < k.notAfter;
}
/** PUBLIC-key-only authenticity check. Does NOT consume a nonce or revalidate authorization. */
export async function verifyBrokerAssertionSignature(raw: unknown, keys: BrokerKeySource, now: number): Promise<boolean> {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== 'claims,signature') return false;
    // Snapshot before awaiting key I/O, so verification cannot authenticate different bytes than checked.
    const a = JSON.parse(JSON.stringify(raw)) as BrokerAssertion;
    const c = a.claims;
    if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== FIELDS.length || !FIELDS.every(f => Object.hasOwn(c, f))) return false;
    if (c.version !== 'B4-03/1' || c.algorithm !== 'Ed25519' || c.environment !== 'development' || c.issuer !== BROKER_ISSUER ||
      c.audience !== BROKER_AUDIENCE || c.workloadId !== BROKER_WORKLOAD || c.actorType !== 'staff' || c.operation !== 'branches:read' ||
      c.permission !== 'branches:view' || c.authorizationVersion !== null || !int(now) || !int(c.issuedAt) || !int(c.expiresAt) ||
      c.issuedAt > now || c.expiresAt <= now || c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > 60 ||
      ![c.actorId,c.sessionId,c.businessId,c.branchId,c.requestId,c.nonce].every(x => typeof x === 'string' && BROKER_UUID.test(x)) ||
      typeof a.signature !== 'string' || !/^[0-9a-f]{128}$/.test(a.signature)) return false;
    const k = await keys();
    if (!validBrokerKey(k, now) || k.keyId !== c.keyId || k.version !== c.keyVersion || c.issuedAt < k.notBefore || c.expiresAt > k.notAfter) return false;
    const key = await crypto.subtle.importKey('raw', bytes(k.publicKeyHex), 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytes(a.signature), brokerAssertionMessage(c));
  } catch { return false; }
}
