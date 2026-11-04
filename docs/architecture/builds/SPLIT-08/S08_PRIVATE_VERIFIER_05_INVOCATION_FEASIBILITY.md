# S08-PRIVATE-VERIFIER-05 — Private Invocation Feasibility and Authentication Contract

**Scope:** Offline development-only verification. **No infrastructure writes, secrets, Stripe requests or deployment.**
**Baseline:** `main` `2e69d68313ea482c251e6071489100babf72c1e5`; PRs #203 and #204 merged.
**Operating model:** ECHO GRID independently operated; INFINICUS LLC is the host for a separate temporary test-only verifier. Existing ECHO GRID production/staging Workers remain in the personal Cloudflare account.

## External feasibility findings (2026-11-03)

- Cloudflare documents Service Bindings as private Worker-to-Worker communication that avoids public URLs: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- Cloudflare documents RPC methods callable by Workers **on the same Cloudflare account**: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ and https://developers.cloudflare.com/workers/runtime-apis/rpc/
- Cross-account direct Service Binding/RPC support is **NOT ESTABLISHED** by these documented contracts. Treat cross-account invocations as unsupported for this design until explicitly proven by authoritative Cloudflare evidence; do not silently create public relay endpoints.

## Decision — development architecture only

A future independently approved **isolated test caller Worker** *in the INFINICUS LLC Cloudflare account* could use a same-account service binding to reach `echo-grid-s08-stripe-test-verifier` privately. It must not be ECHO GRID's existing production or staging Worker by default. Such a caller has **not** been created or authorized for deployment.

Proposed private transport alone does not establish authorization. The verifier must require:
1. A trusted runtime authenticator that independently verifies caller principal, audience and credential revision. User-supplied headers, RPC arguments or a self-asserted `verified` boolean are NOT sufficient.
2. Trusted, approved, unexpired, unrevoked inventory and exact operation allowlist; never grant based on a committed Markdown document alone.
3. Audience binding to the approved destination (account and immutable Worker UUID), with target and caller revision bound to the authorization.
4. Bounded issuance/expiry timestamps, a well-formed unpredictable nonce and an **atomic durable claim-once store** with TTL. A Worker isolate memory Set or KV read-then-write is NOT sufficient for production replay resistance.
5. Safe failure when authentication, replay store or approval information is missing or unavailable.
6. No credentials, invoice raw data or provider network I/O in this block.

## Implemented source

- `apps/api/src/billing/private-stripe-verifier-invocation.contract.ts`: offline authorizer that validates request shape, approval, exact principal/audience/revision/method and calls injected trusted authenticator and atomic nonce claimant. Returns a minimal decision only.
- `apps/api/src/billing/private-stripe-verifier-invocation.contract.test.ts`: synthetic validation, replay, denial and injected failure-path tests; no live key material or network access.

**Not an operational security boundary:** the authorizer accepts an injected `authenticate` function; this PR does not implement any cryptographic token/signature validation, Cloudflare attestation, authoritative approval loading, or durable atomic replay adapter. The synthetic tests exercise a fake authenticator and a local Set for contract behavior only. Production integration must independently implement and security-test those dependencies before any invocation.

## Unresolved gates / no-go conditions

- Authorization model and trust anchor for the isolated caller, including capability provisioning, rotation and revocation.
- Cloudflare account's effective same-account Service Binding availability, verified account-level IAM, executable runtime identity and immutable deployment revision.
- A durable atomic replay store, expiry, race/retry behavior and validated principal proof across Cloudflare runtimes.
- Trusted inventory approval source and trusted exact invoice/business/customer/subscription scope.
- Security review covering the business-specific tenant isolation and rate limits.
- Explicit owner approval for any new caller resource, verifier deployment, bindings or secrets. PR merge never authorizes these operations.
- Temporary retirement after test; record dependencies and obtain deletion authorization.

**Verdict:** GO for **offline development review and tests**. NO-GO for deploying or invoking the verifier, creating a caller Worker, issuing keys, retrieving invoices or using evidence to authorize financial settlement.

## Security remediation — independent review of initial PR #205 head

Following the independent review of original commit `d7bfae4cfd74319af95fde1ae35d4f901bb9d642`, offline code was revised to address the contract-level findings:

1. **Request-bound proof contract:** `authenticate(proof, canonicalRequest)` must cryptographically verify the exact canonical request bytes, including audience, method, inventory revision, nonce, Unix-millisecond timestamps and complete invoice scope; response must attest the exact request. The fake test authenticator demonstrates tamper denial, but is NOT cryptographic authentication and must never be deployed.
2. **Consistent timing:** Request timestamps are Unix epoch **milliseconds**, 300,000 ms maximum lifetime, 30,000 ms maximum clock skew, replay-store TTL derived by `ceil(remainingMs / 1000)` and request expiry must not exceed approval expiry.
3. **Scoped invoice requests:** The invoice method requires an exact approved, trusted invoice/business/customer/subscription scope in the policy and the request. These identifiers must ultimately be corroborated through independently authorized data and Stripe evidence; equality of strings alone is NOT tenant authority.
4. **Collision-safe replay key:** JSON array encoding for principal/audience/revision/nonce; injected atomic one-use claim interface. Production-safe atomic durable implementation and concurrency verification are **still outstanding**.

**Certification limitation:** No real signed proof verifier, bound transport identity, authoritative approval source or distributed atomic replay store has been integrated. The changes correct the *offline contract*; operational authentication, independent runtime security certification and deployment remain NO-GO. All tests are synthetic and not a security certification of Cloudflare runtime behavior.
