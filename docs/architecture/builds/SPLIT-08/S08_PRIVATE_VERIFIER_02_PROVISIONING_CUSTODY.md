# S08-PRIVATE-VERIFIER-02 — workload and restricted credential custody handoff

**State:** development-only preparation; actual Cloudflare provision and key custody **NOT VERIFIED**.  
**Scope:** account `acct_1TtKaUQ0xjd6eYbP`, **Stripe test mode only**.  
**Inventory:** [S08-STRIPE-PRIVATE-TEST-VERIFIER-001](S08_PRIVATE_STRIPE_TEST_VERIFIER_INVENTORY.md).

## Pre-provision approval gate

The owner/authorized operators must independently approve:
- Exact Cloudflare account and permitted deploy identity.
- Dedicated Worker `echo-grid-s08-stripe-test-verifier`, source `apps/private-stripe-verifier`, test environment, and deployment of the **inert 404-only** code (deployment is a separate operation requiring explicit approval).
- Issuance of **new** Stripe restricted **test-mode** key for the designated account, read-only on the account and invoice resources to the minimum scope Stripe actually supports.
- Direct-to-Cloudflare secret custody, binding name `STRIPE_TEST_VERIFIER_RESTRICTED_KEY`; no key reuse, no plaintext in files, console transcripts, CI, chat, or Git.
- Named approver, purpose, permission scope, immutable revision, rotation/revocation owner and expiry/review date.

Do not infer any of these from the existence of this document, CI, merged PRs, or a connected Stripe test account. Stop if Cloudflare/Stripe permissions do not support the proposed least privilege.

## Cloudflare workload identity — authorized console procedure

1. Authenticate to the correct **owner-approved** Cloudflare account. Record non-secret account reference and the identity of the operator permitted to create a Worker.
2. Inspect existing Worker names for collision. If no such Worker exists and deployment has been separately approved, create/deploy only the reviewed inert Worker from `apps/private-stripe-verifier`. Its `wrangler.toml` specifies `workers_dev=false`. **Do not deploy as part of this document-writing step.**
3. Verify from the Cloudflare console/API (not only source config): Worker script identity and account; effective workers.dev status; absence of routes, custom domains, schedules, queues, public triggers and outbound Stripe operations; selected immutable version/revision.
4. Record worker account/scope and immutable deployed version in the inventory. A Worker name is not a cryptographic identity; record the actual trust and execution boundary.
5. Retain the no-network, 404-only handler; do not attach the secret to the main API Worker or create a public endpoint.

## Restricted Stripe credential — authorized console procedure

1. Select Stripe **test mode** for `acct_1TtKaUQ0xjd6eYbP`. Confirm account identity visually against the approved inventory. Never operate against live mode.
2. In the Stripe Dashboard restricted API key interface, create a **new restricted test key** (not a standard test secret or existing billing key). Request read-only access for only the account and invoice operations required for the verifier. Review the exact resource permissions offered; if the supported grant is broader than approved, STOP for owner review.
3. Record non-secret key inventory locator/ID (if supported), creation/rotation revision, owner, exact approved method scope and review/expiry. Do **not** copy or paste the key into any chat, GitHub issue, PR, file, CI variable or command history.
4. In the **approved private Worker** Cloudflare Dashboard, set an encrypted secret named `STRIPE_TEST_VERIFIER_RESTRICTED_KEY` directly from the Stripe restricted-key creation flow. Key material must remain exclusively inside approved operator/secret-store surfaces. Verify only presence/name and its platform-managed revision, not its value.
5. Assess whether the secret change generates a new deployed Worker version, requires deployment, or could expose a new route. Do not approve or perform such deployment automatically; retain proof of the actual version and effective runtime boundaries.
6. Verify key custody and rotate/revoke on unauthorized distribution or mode/permission mismatch.

## Post-provision acceptance record (metadata only)

| Evidence | Current state |
| --- | --- |
| Owner-authorized Cloudflare account and operator identity | PENDING |
| Deployment authorization and actual Worker script identity | PENDING |
| Effective `workers_dev=false`, route/trigger audit, deployed revision | PENDING |
| Stripe account ID `acct_1TtKaUQ0xjd6eYbP` and test realm | OWNER-DESIGNATED; private principal unverified |
| Stripe restricted **test** key inventory reference/version | PENDING |
| Exact supported read-only resource permissions | PENDING |
| Secret binding `STRIPE_TEST_VERIFIER_RESTRICTED_KEY` present on correct Worker | PENDING |
| Separate read-execution approval | PENDING |

Once the record is filled and independently approved, **a different, separately authorized block** may perform `GET /v1/account` followed by the exact-scoped test invoice read. Neither provisioning nor possession of a key grants those reads by itself. No financial operations, invoice writes or Partner Credit consumption are authorized.

**Verdict at creation:** NO-GO for private verifier execution and key-provisioning success claims.
