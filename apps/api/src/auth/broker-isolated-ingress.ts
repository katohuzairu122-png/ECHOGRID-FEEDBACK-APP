/**
 * B4-10 — unmounted isolated broker ingress validation.
 *
 * Transport parsing and cryptographic provenance only. A verified invocation
 * MUST NOT execute SQL, consume nonces, check user memberships or grant a
 * production capability: no certified restricted role exists yet.
 */
import { verifyB409Invocation, type B409Invocation } from './broker-workload-attestation';
import { validBrokerKey, type BrokerKeySource, type BrokerVerificationKey } from './broker-assertion.contract';

export type B410IngressResult = Readonly<{
  acceptedForEvaluation: boolean;
  brokerAuthorization: 'NOT_GRANTED';
  deploymentAuthorized: false;
  reason:
    | 'METHOD_OR_PATH_DENIED'
    | 'UNSUPPORTED_MEDIA'
    | 'BODY_LIMIT_EXCEEDED'
    | 'INGRESS_TIMEOUT'
    | 'MALFORMED_INVOCATION'
    | 'UNTRUSTED_PROVENANCE'
    | 'PROVENANCE_ONLY';
}>;

const MAX_BODY_BYTES = 8192;
const MAX_BODY_CHUNKS = 8192;
const MAX_INGRESS_MS = 5000;
class IngressTimeout extends Error {}
const PATH = '/internal/broker/v1/branch-read';
const denied = (reason: B410IngressResult['reason']): B410IngressResult =>
  Object.freeze({ acceptedForEvaluation: false, brokerAuthorization:'NOT_GRANTED',
    deploymentAuthorized:false, reason });

/**
 * A pure request-entry preflight suitable for isolated tests only.
 * Key sources MUST be supplied by an independently trusted composition root,
 * not from request fields, URLs, or headers. This is not a deployed endpoint.
 */
export async function inspectB410Ingress(
  request: Request,
  assertionKeys: BrokerKeySource,
  workloadKeys: BrokerKeySource,
  clock: () => number,
): Promise<B410IngressResult> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== PATH || url.search ||
        url.hash || url.username || url.password) return denied('METHOD_OR_PATH_DENIED');
    if (request.headers.get('content-type')?.toLowerCase() !== 'application/json') return denied('UNSUPPORTED_MEDIA');
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) ||
        Number(declared) > MAX_BODY_BYTES)) return denied('BODY_LIMIT_EXCEEDED');

    reader = request.body?.getReader();
    if (!reader) return denied('MALFORMED_INVOCATION');
    // One deadline covers body reads and both trusted key lookups. A stalled
    // producer or key provider must not hold this preflight open indefinitely.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new IngressTimeout()), MAX_INGRESS_MS);
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES || chunks.length >= MAX_BODY_CHUNKS) {
          return denied('BODY_LIMIT_EXCEEDED');
        }
        // Own bytes even when an underlying producer reuses its buffer.
        chunks.push(value.slice());
      }
    if (!total) return denied('MALFORMED_INVOCATION');
    const body = new Uint8Array(total);
    let offset=0;
    for(const part of chunks){body.set(part,offset);offset+=part.byteLength;}
    // This Workers type target does not expose TextDecoder's fatal option.
    // A byte-for-byte UTF-8 round trip rejects invalid sequences, including
    // decoded replacement characters inserted for malformed input.
    const decoded = new TextDecoder().decode(body);
    const reencoded = new TextEncoder().encode(decoded);
    if (reencoded.length !== body.length || reencoded.some((byte, i) => byte !== body[i])) {
      return denied('MALFORMED_INVOCATION');
    }
    const raw: unknown = JSON.parse(decoded);
    // Provenance is cryptographic and read-only, not authorization or
    // credential attestation. No SQL connection exists in this module.
    const now = clock();
    const keys: BrokerVerificationKey[] = [];
    const capture = (source: BrokerKeySource): BrokerKeySource => async () => {
      const supplied = await source();
      const key = supplied ? { ...supplied } : null;
      if (key) keys.push(key);
      return key;
    };
    const verified = await Promise.race([
      verifyB409Invocation(raw, capture(assertionKeys), capture(workloadKeys), now), deadline,
    ]);
    if (!verified.provenanceVerified) return denied('UNTRUSTED_PROVENANCE');
    // Verification can outlive the assertion or a key window. Use a trusted
    // fresh clock at acceptance, never the time from before request reading.
    const finished = clock();
    const invocation = raw as B409Invocation;
    if (!Number.isSafeInteger(finished) || finished < now ||
        invocation.assertion.claims.expiresAt <= finished || invocation.workloadEvidence.expiresAt <= finished ||
        keys.length !== 2 || !keys.every(key => validBrokerKey(key, finished))) return denied('UNTRUSTED_PROVENANCE');
    return Object.freeze({acceptedForEvaluation:true,brokerAuthorization:'NOT_GRANTED',
      deploymentAuthorized:false,reason:'PROVENANCE_ONLY'});
  } catch (error) {
    if (error instanceof IngressTimeout) return denied('INGRESS_TIMEOUT');
    return denied('MALFORMED_INVOCATION');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (reader) {
      // Cancellation belongs to the untrusted stream. Observe rejection but
      // never await it; a hanging cancellation cannot hold the result hostage.
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
