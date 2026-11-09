/**
 * B4-10 — unmounted isolated broker ingress validation.
 *
 * Transport parsing and cryptographic provenance only. A verified invocation
 * MUST NOT execute SQL, consume nonces, check user memberships or grant a
 * production capability: no certified restricted role exists yet.
 */
import { verifyB409Invocation, type B409Invocation } from './broker-workload-attestation';
import type { BrokerKeySource } from './broker-assertion.contract';

export type B410IngressResult = Readonly<{
  acceptedForEvaluation: boolean;
  brokerAuthorization: 'NOT_GRANTED';
  deploymentAuthorized: false;
  reason:
    | 'METHOD_OR_PATH_DENIED'
    | 'UNSUPPORTED_MEDIA'
    | 'BODY_LIMIT_EXCEEDED'
    | 'MALFORMED_INVOCATION'
    | 'UNTRUSTED_PROVENANCE'
    | 'PROVENANCE_ONLY';
}>;

const MAX_BODY_BYTES = 8192;
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
  now: number,
): Promise<B410IngressResult> {
  try {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== PATH || url.search ||
        url.hash || url.username || url.password) return denied('METHOD_OR_PATH_DENIED');
    if (request.headers.get('content-type')?.toLowerCase() !== 'application/json') return denied('UNSUPPORTED_MEDIA');
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) ||
        Number(declared) > MAX_BODY_BYTES)) return denied('BODY_LIMIT_EXCEEDED');

    const reader = request.body?.getReader();
    if (!reader) return denied('MALFORMED_INVOCATION');
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY_BYTES) {
          await reader.cancel();
          return denied('BODY_LIMIT_EXCEEDED');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!total) return denied('MALFORMED_INVOCATION');
    const body = new Uint8Array(total);
    let offset=0;
    for(const part of chunks){body.set(part,offset);offset+=part.byteLength;}
    const raw: unknown = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
    // Provenance is cryptographic and read-only, not authorization or
    // credential attestation. No SQL connection exists in this module.
    const verified = await verifyB409Invocation(raw as B409Invocation, assertionKeys, workloadKeys, now);
    if (!verified.provenanceVerified) return denied('UNTRUSTED_PROVENANCE');
    return Object.freeze({acceptedForEvaluation:true,brokerAuthorization:'NOT_GRANTED',
      deploymentAuthorized:false,reason:'PROVENANCE_ONLY'});
  } catch {
    return denied('MALFORMED_INVOCATION');
  }
}
