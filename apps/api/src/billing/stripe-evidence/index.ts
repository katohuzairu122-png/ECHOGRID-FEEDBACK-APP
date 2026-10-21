// B5: decrypt (openPayload, unwrapDek, rewrapDek) is deliberately NOT re-exported. Only forensic.ts decrypts evidence;
// keyring-ops.ts and evidence.store.ts import the primitives they need directly from './envelope'.
export { EVIDENCE_SCHEMA_VERSION, EvidenceCryptoError, canonicalAad, createWrappedDek, equalBytes, sealPayload, sha256 } from './envelope';
export type { EnvelopeBinding, SealedEnvelope, WrappedDek } from './envelope';
export * from './keyring';
export * from './shape';
export * from './signature';
export * from './evidence.store';
export * from './control-events';
export * from './capture.config';
export * from './capture.handler';
export * from './ucw';
export * from './watchdog';
export * from './heartbeat';
export * from './attestation';
export * from './keyring-ops';
export * from './reconcile';
export * from './forensic';
