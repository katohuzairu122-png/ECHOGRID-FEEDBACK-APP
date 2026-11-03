# S08-PRIVATE-VERIFIER-04 — Private execution boundary: proposed contract and threat review

**State:** DEVELOPMENT PROPOSAL — NO DEPLOYMENT, NO EXECUTION, NO CREDENTIALS.  
**Baseline:** main `1ca0ff0eb7551a18286e9162006f620fbb0ca66e` (PR #202 merged); PR #203 temporary resource identity/evidence remains open at drafting time.  
**Owner-selected hosting:** INFINICUS LLC Cloudflare account `b0ca727d821092e2e14720223ac07edb`. ECHO GRID is **independently operated**; this is not an ownership transfer.  
**Temporary Cloudflare resource (Codex-reported, not independently repeated here):** script `echo-grid-s08-stripe-test-verifier`, UUID `4c3ac5ade3354c018e56f2307db5c028`, 0 versions, 0 deployments, no public ingress.  
**Target Stripe test account:** `acct_1TtKaUQ0xjd6eYbP`, designation only; private verifier principal unverified.

## Design decision pending owner review

The **default** is a dedicated Worker with **no public ingress**, no scheduler/queue/event handler, no deployed code and no secrets. Future invocation may be permitted **only** by a separately approved authenticated private control plane. An internal Cloudflare service binding alone proves an invocation path, **not** the ECHO GRID operator's authority to request a Stripe read. Do not equate account membership, script name or UUID with caller authentication.

### Proposed caller and verifier boundaries

1. **Caller/entry:** A future dedicated test orchestration identity, explicitly enrolled and restricted to this test workload. Do not expose verifier as a public URL or bind the production ECHO GRID Worker to the verifier by default. The main production API must not become an implicit invoker.
2. **Transport:** Prefer a Cloudflare Worker-to-Worker service binding when an authorized caller can exist within the required account boundary, with binding only on the approved caller and target. Cross-Cloudflare-account service-binding feasibility, operator rights and any alternative private transport **must be verified** before selection. No proxy, public route or external relay is automatically authorized.
3. **Authentication:** Use authenticated control-plane attestation or a separately approved short-lived, audience-bound invocation identity. Requests must bind to the exact caller principal, verifier script UUID, Cloudflare account/environment and operation. An arbitrary header, a guessed token, Workers OAuth membership, or service binding alone is insufficient.
4. **Authorization:** Exact test account, preapproved invoice target and operation scope; immutable inventory revision, approver, expiry, revocation state and method allowlist; fail closed if any is absent, stale, mismatched or unsupported. Use `preflightPrivateStripeVerifier` as an **offline design reference**, not a substitute for authenticated approvals.
5. **Data:** Allow only the minimal request payload needed for a named, approved point-in-time test. Never accept arbitrary Stripe URL, arbitrary account override, user-supplied credential, untrusted tenant choice, unrestricted invoice search or unrestricted customer selection.
6. **Output:** Emit a minimal non-sensitive decision/evidence receipt. Raw invoices, customer PII, full Stripe response bodies, restricted key material and authorization tokens must not be logged or returned in success/errors. Audit records need correlation ID, inventory revision, method, allowed/denied result and verified resource identity without secrets.
7. **No financial authority:** Evidence cannot trigger benefit consumption, invoice mutation, credit allocation, settlement or ledger writes. Require the existing independent accounting and reconciliation gates in their separate control plane.

## Threat and failure matrix

| Threat | Required response |
| --- | --- |
| Unauthorized user or Worker invokes verifier | Fail closed, no Stripe call, no secret exposure |
| Host account script name spoofed / UUID changes | Reject until immutable account + UUID/revision attestation reapproved |
| Cross-account invocation is unsupported | Block. Do not replace private channel with a public endpoint |
| Service binding inadvertently added to production Worker | Block and obtain an independent architecture/production compatibility review |
| Missing/expired/revoked approval or changed inventory | Deny before any network call |
| Credential reference, scope, test realm or version differs | Deny; never fall back to main API key or live mode |
| Stripe account override / `Stripe-Account` header | Deny |
| Invoice ID not bound to authorized business/customer/subscription evidence | Deny |
| Test account principal does not match `acct_1TtKaUQ0xjd6eYbP` | Stop verification immediately |
| Preview URL, custom domain, workers.dev or route becomes active | Block execution and investigate ingress |
| Secret injection updates deployed version or changes bindings | Require separate deployment/change approval and rerun attestations |
| Unknown API errors/timeouts or ambiguous Stripe response | Fail closed and capture metadata-only diagnostic |
| Replay or duplicate invocation | Use independently validated one-use authorization / bounded nonce; no effect on financial records |
| Resource remains after test completion | Reconcile dependencies, revoke access, and request separate owner-approved teardown |

## Sequence of independently authorized future gates

**Gate 0 — Contract review:** Approve the selected private invocation and authentication mechanism, including cross-account feasibility and security constraints. Documentation only in this PR.

**Gate 1 — Executable boundary implementation:** Independent development PR with local tests for deny-all default, trusted caller auth, replay handling, inventory binding, method allowlist, test-realm enforcement, no secret logging and failure paths. No deploy script added; no code deployed.

**Gate 2 — Deployment authorization:** Only after independently reviewed build/tests and explicit owner approval, deploy the inert or guarded executable Worker to the exact temporary resource. Verify actual account, UUID, deployed hash, ingress, runtime bindings and triggers.

**Gate 3 — Credential custody:** Separate authorization to provision a new least-privilege restricted **test** key directly to the dedicated Worker's encrypted secret binding `STRIPE_TEST_VERIFIER_RESTRICTED_KEY`. Capture inventory reference and resource/version mapping. No direct secret transfer through GitHub/ChatGPT.

**Gate 4 — Point-evidence execution:** Separate read-only authorization, approved private invocation and exact test invoice. Authenticate `GET /v1/account` before exact `GET /v1/invoices/{id}`; pin API version and confirm `livemode=false`. No write or consumption authority.

**Gate 5 — Temporary retirement:** Confirm zero dependencies and no deployed execution, revoke key and caller authorization, then obtain separate deletion authorization for the Worker and evidence retention.

## Present state / acceptance

| Item | State |
| --- | --- |
| Resource exists in selected account | REPORTED VERIFIED by Codex, UUID above; independent Cloudflare recheck pending |
| Code implementation | Existing 404-only scaffold in Git; NOT DEPLOYED |
| Internal invocation mechanism | **NOT APPROVED; cross-account feasibility unknown** |
| Caller authentication and execution grant | NOT IMPLEMENTED / NOT APPROVED |
| Worker deployment | 0 reported |
| Credential custody | NOT PROVISIONED |
| Stripe requests | NONE |
| Financial features | NONE |
| Cleanup ownership | Owner review required before resource deletion |

**Conclusion:** NO-GO for executable workload deployment, credential installation and Stripe reads. GO for independent architecture review of this proposal. Preservation of ECHO GRID's four personal-account production/staging Workers and INFINICUS LLC's existing Voice resources is mandatory.
