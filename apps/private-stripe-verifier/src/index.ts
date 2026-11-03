/**
 * S08 private Stripe test verifier — intentionally inert execution boundary.
 * This Worker must never serve a public endpoint or contact Stripe before
 * workload attestation, approved inventory and secret custody are verified.
 * A service binding or internal-only trigger requires a separately reviewed
 * handler implementation and explicit execution authorization.
 */
export default {
  fetch(): Response {
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  },
};
