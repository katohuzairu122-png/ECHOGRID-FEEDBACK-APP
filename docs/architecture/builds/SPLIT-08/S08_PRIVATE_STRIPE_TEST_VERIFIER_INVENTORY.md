# S08 — Private Stripe test verifier inventory (approval pending)

**Record ID:** `S08-STRIPE-PRIVATE-TEST-VERIFIER-001`  
**Status:** `DRAFT / NOT APPROVED / EXECUTION DENIED`  
**Created:** 2026-11-03  
**Purpose:** Inventory the exact account, test realm, workload, credential reference, and read scope required to qualify a *private*, read-only Stripe point-evidence verifier.

This document is an **inventory record to be completed and approved**. Its presence in Git or a merged PR **does not authorize Stripe access**. No values below have been independently established unless an approval evidence link is supplied. Keep secrets in their existing secret store; never commit keys, tokens, invoices with customer information, or raw credentials.

## 1. Scope and inventory fields

| Field | Value / required evidence |
| --- | --- |
| Stripe account ID expected from authenticated `GET /v1/account` | **PENDING — exact `acct_…` ID must be entered and verified** |
| Stripe realm | **PENDING — must explicitly approve `test`; live mode is forbidden** |
| Credential owner / approved organization | **PENDING** |
| Private verifier workload identity / service principal | **PENDING — immutable workload identity and environment binding** |
| Verifier approved execution path | **PENDING — exact private job/service entry point, environment, repository revision and deployment/runner boundary** |
| Secret store / credential inventory locator | **PENDING — inventory URI or identifier only, no secret value** |
| Restricted credential version / revision | **PENDING — immutable inventory version; record rotation/supersession** |
| Permitted Stripe API operation 1 | **PENDING APPROVAL** — proposed `GET /v1/account`, only for principal/account confirmation |
| Permitted Stripe API operation 2 | **PENDING APPROVAL** — proposed `GET /v1/invoices/{id}`, exact trusted locally selected invoice in the approved account |
| API version | `2026-05-27.dahlia` — repository's proposed explicitly pinned invoice read version; reverify at execution |
| Account selection | **Direct account only as proposed**; deny Connect/Stripe-Account overrides unless separately inventoried and approved |
| Invoice scope selection / trusted binding | **PENDING** — trusted local business, customer, subscription and invoice reference with immutable revision |
| Read access authorization record | **PENDING — approval link, approver, approved account, realm, specific methods and expiry** |
| Workload execution authorization record | **PENDING — approval link, approver, exact environment/path and expiry** |
| Inventory approver and decision timestamp | **PENDING** |
| Review/expiry/revocation status | **PENDING — fail closed if absent, expired, revoked or superseded** |

The staging account ID used in an earlier, separate check is **not inherited** by this verifier. The responsible approver must explicitly bind that exact ID to this record, verify it against the credential's account principal and approve test-realm access. No implicit staging-to-verifier mapping is permitted.

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
- **Account ID / test-realm approval reference:** PENDING
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

**Current disposition:** `INVENTORY CREATED / VALUES PENDING / NO PROVIDER REQUESTS AUTHORIZED`. Do not enter a guessed Stripe account or credential version, and do not infer permission from CI, repository merge status or the earlier staging check.
