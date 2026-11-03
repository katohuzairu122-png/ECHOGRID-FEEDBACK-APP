# S08 — Private Stripe test verifier inventory (approval pending)

**Record ID:** `S08-STRIPE-PRIVATE-TEST-VERIFIER-001`  
**Status:** `OWNER ACCOUNT DESIGNATED / WORKLOAD AND CREDENTIAL APPROVAL PENDING / EXECUTION DENIED`  
**Created:** 2026-11-03  
**Purpose:** Inventory the exact account, test realm, workload, credential reference, and read scope required to qualify a *private*, read-only Stripe point-evidence verifier.

This document is an **inventory record to be completed and approved**. Its presence in Git or a merged PR **does not authorize Stripe access**. No values below have been independently established unless an approval evidence link is supplied. Keep secrets in their existing secret store; never commit keys, tokens, invoices with customer information, or raw credentials.

## 1. Scope and inventory fields

| Field | Value / required evidence |
| --- | --- |
| Stripe account ID expected from authenticated `GET /v1/account` | **OWNER-DESIGNATED:** `acct_1TtKaUQ0xjd6eYbP` (Infinicus simulation engine); credential principal still must be independently verified |
| Stripe realm | **OWNER-DESIGNATED:** `test`; connected Stripe account discovery reported `livemode=false` (not a private-verifier attestation) |
| Credential owner / approved organization | **ECHO GRID ownership transfer NOT COMPLETE.** INFINICUS LLC (`b0ca727d821092e2e14720223ac07edb`) is proposed Cloudflare hosting account only; credential owner, cross-entity custody, permissions and execution approval **PENDING** |
| Private verifier workload identity / service principal | **PROPOSED HOSTING TARGET — NOT OWNERSHIP TRANSFER:** INFINICUS LLC (`b0ca727d821092e2e14720223ac07edb`); proposed Worker script `echo-grid-s08-stripe-test-verifier`; actual UUID, provisioned resource, executable identity and runtime attestation **PENDING** |
| Verifier approved execution path | **PROPOSED, NOT APPROVED:** `apps/private-stripe-verifier/src/index.ts`, configured by `apps/private-stripe-verifier/wrangler.toml`; private Cloudflare Worker with `workers_dev=false`, no routes/triggers, and deny-all entry point; deployment account, immutable deployed revision and execution authorization PENDING |
| Secret store / credential inventory locator | **PROPOSED STORE/BINDING, NOT PROVISIONED:** Cloudflare Workers encrypted secret binding `STRIPE_TEST_VERIFIER_RESTRICTED_KEY` on the dedicated Worker; exact Cloudflare account, secret inventory URI/ID and custody evidence PENDING |
| Restricted credential version / revision | **PENDING — create a *new*, minimum-scope Stripe TEST restricted API key and inventory its immutable version; never reuse general API/production keys** |
| Permitted Stripe API operation 1 | **PENDING APPROVAL** — proposed `GET /v1/account`, only for principal/account confirmation |
| Permitted Stripe API operation 2 | **PENDING APPROVAL** — proposed `GET /v1/invoices/{id}`, exact trusted locally selected invoice in the approved account |
| API version | `2026-05-27.dahlia` — repository's proposed explicitly pinned invoice read version; reverify at execution |
| Account selection | **Direct account only as proposed**; deny Connect/Stripe-Account overrides unless separately inventoried and approved |
| Invoice scope selection / trusted binding | **PENDING** — trusted local business, customer, subscription and invoice reference with immutable revision |
| Read access authorization record | **PENDING — approval link, approver, approved account, realm, specific methods and expiry** |
| Workload execution authorization record | **PENDING — approval link, approver, exact environment/path and expiry** |
| Inventory approver and decision timestamp | **PENDING** |
| Review/expiry/revocation status | **PENDING — fail closed if absent, expired, revoked or superseded** |

**Owner account designation (2026-11-03):** The owner explicitly designated `acct_1TtKaUQ0xjd6eYbP`, named **Infinicus simulation engine**, as ECHO GRID's approved *test-account selection* for this verifier. A connected Stripe account listing returned this account with `livemode=false`. This is a deliberate cross-project test account selection, not approval of credential custody, a workload identity, execution, or financial operations. The earlier staging account is not silently inherited; only this explicitly designated ID may be used, and `GET /v1/account` must still verify the principal under the eventual restricted credential. Connected-account discovery is not sufficient evidence of the private credential's identity.

**Cloudflare account decision (2026-11-03):** Owner identified INFINICUS LLC account `b0ca727d821092e2e14720223ac07edb` for this private verifier. The personal account `cf205213947e3617297373060fe4c15f` is excluded. This authorizes account-scoped Worker inventory inspection only at this stage; the actual Worker identity, resource existence, version, secret custody and read-execution approval are outstanding.


> **Ownership boundary correction (2026-11-03):** ECHO GRID has **not** been transferred to INFINICUS LLC. The owner's earlier approval identified the INFINICUS LLC Cloudflare account as a *proposed verifier hosting destination*, not a transfer of project ownership, repositories, billing, credentials, or financial responsibility. Until a separately documented cross-entity hosting arrangement and access/custody authorization is approved, **do not create the Worker, deploy code, attach bindings, or provision credentials in the INFINICUS LLC account**. Read-only inspection of the selected account remains the only authorized infrastructure action.

**Owner operating model (2026-11-03):** ECHO GRID remains independently operated and uses INFINICUS LLC as an infrastructure hosting provider. This is **not an ownership transfer**. See [S08-PV02-HOSTING-01](S08_PRIVATE_VERIFIER_02_HOSTING_OPERATING_MODEL.md) for distinct operational, infrastructure, credential and provisioning authority boundaries. The hosting decision does not itself authorize Worker creation, code deployment or secret issuance.

### Proposed environment boundary (not yet provisioned)

- **Platform:** Cloudflare Workers (same infrastructure family as ECHO GRID, separately scoped service).
- **Script identifier:** `echo-grid-s08-stripe-test-verifier` (repository designation only; Cloudflare resource existence has **not** been verified).
- **Source:** `apps/private-stripe-verifier/src/index.ts`; configuration `apps/private-stripe-verifier/wrangler.toml`. Private service has no public routes or workers.dev subdomain; its current handler returns 404 and contains no Stripe network code.
- **Credential slot:** `STRIPE_TEST_VERIFIER_RESTRICTED_KEY` (name only). Actual secret must be issued as restricted TEST API key from the approved Stripe account and written directly by the authorized operator to this Worker's existing Cloudflare secret store. No secret or key-material transit through GitHub, chat or CI.
- **Remaining authority checks:** Cloudflare organization/account owner, deployment/runner attestation, exact workload IAM privileges, Stripe restricted-key method permissions, secret inventory/version, and separate scope/read approval are all **PENDING**. A script name is not a cryptographic workload identity.
- **Do not deploy:** Private execution path and credential bindings are architectural preparations only. No code push or PR approval authorizes deployment or network access.

## 2. Approval and execution gates

All of these conditions are mandatory **before** any private verifier read:

1. The responsible authorized owner supplies and approves the exact Stripe account ID, explicitly designated **test** realm, verifier workload identity, private execution path and immutable credential inventory reference/version.
2. A separately recorded approval grants only the minimum account read and exact-invoice read in that account and environment. Validate the credential's actual permissions and deny unapproved calls.
3. The inventory owner confirms the secret remains in its existing secret manager and is available **only to the approved workload**. Never expose the secret in logs, PRs or evidence files.
4. The operator checks current approval, inventory version, workload attestation, environment, revocation status and incident restrictions immediately before the request. Any unknown/missing/conflicting element stops the verifier.
5. If all gates pass, issue read-only `GET /v1/account` in the approved private path. Compare the returned account ID to the approved inventory account ID; mismatch = stop.
6. With the same verified scope, retrieve **only** the trusted locally selected invoice via `GET /v1/invoices/{id}` using the approved API version. Require `livemode=false`, exact returned invoice ID and independently established business/customer/subscription linkage; unsupported or ambiguous parent/scope = stop.
7. Record an immutable **point observation**: redacted request ID, start/receipt timestamps and clock uncertainty, requested API version, account/realm, credential inventory reference and version (never the secret), identity and policy revisions, invoice response digest and locally bound invoice fields. No customer data or authentication material in plaintext logs.
8. Point evidence never authorizes invoice changes, invoice-item creation, Partner Credit consumption, settlement, ledger changes or financial release. Keep allocation authority flags disabled and all database guards intact. Later source/revision changes revoke reliance.

## 3. Approval evidence (not yet granted)

- **Scope owner / approver:** PENDING
- **Approval decision and timestamp:** PENDING
- **Approval ticket / immutable evidence reference:** PENDING
- **Account ID / test-realm selection reference:** owner designation in the 2026-11-03 conversation; account `acct_1TtKaUQ0xjd6eYbP`, test realm; independent private credential identity attestation PENDING
- **Workload identity and private execution-path approval reference:** PENDING
- **Account and invoice read permission authorization reference:** PENDING
- **Credential inventory location and version attestation reference:** PENDING
- **Revocation/expiry and scheduled review owner:** PENDING

**Activation criterion:** A separately signed/traceable authorization references this exact record ID and immutable revision and verifies every field and gate above. A completed form without authorization remains **NO-GO**.

## 4. Preflight decision matrix (offline specification; not an execution report)

For each case, the private verifier must fail closed and produce an audit-safe rejection classification. No test in this section uses or requests a real credential.

| Case | Expected result |
| --- | --- |
| Current draft inventory with any `PENDING` field | **DENY / INVENTORY_INCOMPLETE**; no provider request |
| Inventory document exists or PR/CI passes, but no approval | **DENY / APPROVAL_MISSING**; repository state is not authority |
| Account `acct_…` missing or differs from authenticated account principal | **DENY / ACCOUNT_MISMATCH**; do not request an invoice |
| Real account from earlier staging check but no verifier-specific approval | **DENY / SCOPE_UNAPPROVED** |
| Missing or revoked credential inventory version | **DENY / CREDENTIAL_UNVERIFIED**; do not retrieve a secret |
| Workload identity, execution path, or runner environment differs | **DENY / WORKLOAD_UNAPPROVED** |
| Missing account-read or invoice-read authorization | **DENY / METHOD_UNAPPROVED** |
| A Connect/Stripe-Account override is supplied under a direct-account approval | **DENY / ACCOUNT_OVERRIDE** |
| Scoped invoice response has `livemode=true`, missing mode, or unknown mode | **DENY / REALM_MISMATCH** |
| Invoice response ID, customer or subscription parent differs from trusted binding | **DENY / INVOICE_BINDING_MISMATCH** |
| Invoice is ambiguous, unavailable, or its source/revision evidence is incomplete | **DENY / OBSERVATION_UNQUALIFIED** |
| Approved, current inventory and workload; account identity matches; scoped invoice has `livemode=false` and exact trusted binding | **POINT OBSERVATION ONLY**; no operation/consumption authority |

**Order of operations:** Validate signed approval and inventory revisions *before* resolving the credential or contacting Stripe. Validate the credential's account identity before invoice retrieval. Any failure ends the attempt; do not fall back to a different account, test invoice, key, API version or verification method. Capture each denial using only inventory IDs and non-sensitive error codes.

**Evidence receipt template (future authorized run only):**

- Inventory record ID and approved immutable revision: **PENDING**
- Approver, decision reference, scope expiration and revocation check: **PENDING**
- Workload principal and approved execution path attestation: **PENDING**
- Credential inventory locator and version, never the secret: **PENDING**
- Exact expected/observed account ID and required test realm: **PENDING**
- Exact authorized invoice reference and trusted binding revision: **PENDING**
- API version, request ID (redacted as required), request-start/receipt timestamps and uncertainty: **PENDING**
- Observed `livemode=false`, invoice identity, subscription parent and currency/amount comparison: **PENDING**
- Immutable observation reference, digest, verdict and reviewer: **PENDING**

This template is not evidence that an authorized run occurred. The only permitted verdict before completed approval is **NOT EXECUTED / DENY**.

## 5. Related source decisions

- [S08 test-mode point evidence profile](S08_TEST_MODE_POINT_EVIDENCE_PROFILE.md)
- [S08 method-profile acceptance review](S08_METHOD_PROFILE_ACCEPTANCE_REVIEW.md)
- [S08 authenticated binding source contract](S08_AUTHENTICATED_BINDING_SOURCE_CONTRACT.md)

**Current disposition:** `ACCOUNT DESIGNATED / REMAINING INVENTORY AND PERMISSIONS PENDING / NO PRIVATE PROVIDER REQUESTS AUTHORIZED`. Do not enter a guessed credential version or workload identity, and do not infer private execution permission from CI, repository merge status or connected Stripe account discovery.
