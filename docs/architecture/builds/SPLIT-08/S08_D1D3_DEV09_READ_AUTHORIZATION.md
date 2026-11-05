# S08 D1/D3-DEV-09 — Trusted Stripe Evidence Authorization and Test-Mode Integration

Status: DEVELOPMENT ONLY. Inert. Financial activation: NO-GO. No Stripe contact, no real credentials, no production access, no migration.
Predecessor: PR #228 (DEV-08), unmerged at authoring time. This branch is stacked on its head (`620d984`).

## What changed

| Area | Module | Rule |
|---|---|---|
| Durable read authorization | `read-authorization.ts` | One record per (business, method): business, Stripe account, realm `test`, workload, method, authorization id, validity period, state PENDING/APPROVED/REVOKED. Strict parse; any malformed record makes the whole answer untrusted. Store failure fails closed. Caller assertions never substitute for a record. Expiry is derived at check time. REVOKED is terminal. |
| Capability registry | `read-gate.ts` + existing `decideCapability` | Authorization is per method. The four reads that have no transport path (INVOICE_LINES_LIST, PAYMENT_RETRIEVE, REFUNDS_LIST, DISPUTES_LIST) cannot be enabled by any record, toggle, env var or default (no module in this directory reads the environment). Does **not** approve Q1/Q2. |
| Per-request enforcement | `read-provider.ts` | Authorization + mapping gate evaluated immediately before **every** provider request; a revocation takes effect on the next request. |
| Credentials | `transport.ts` | `CredentialSource.resolve({accountId, workloadId})` per request, after path validation. Live keys, malformed, missing, expired, wrong account/workload rejected with fixed codes (never the value). Static single key still supported (tests only). Redirect refused, timeout, size cap, GET-only fixed paths unchanged. |
| Mapping authority | `mapping-authority.ts` | Every field mapping carries API version, source operation/field, type, destination, status (`SDK_SCHEMA_UNPROVEN_LIVE`, `TEST_MODE_VERIFIED`, `UNSUPPORTED`, `SCHEMA_DRIFT`), completeness conditions, contract version `S08-STRIPE-MAPPING/1`. Catalog is truthful: nothing is verified. Evidence reads require `TEST_MODE_VERIFIED`; none exists, so **real evidence reads are impossible by default**. |
| Proof infrastructure | `proof-capture.ts`, `proof-fixtures.ts` | Authorized, minimized (types and enum values only, never ids/amounts/metadata), fingerprinted, append-only, idempotent proof records. Account/mode/object/invoice verified. Only a sealed `REAL_NETWORK` proof can change a mapping (`applyProof`); synthetic and injected-transport proofs never can. `buildProof` is not exported from the package index. |
| Settlement | unchanged | DEV-03/04/05 database controls untouched. Real-origin evidence is still rejected for settlement (`REAL_EVIDENCE_NOT_AUTHORIZED_FOR_SETTLEMENT`); evidence-kind CHECK still `MOCK_SYNTHETIC` only. |

## Known limits (honest disclosure)

1. `networkSource` is self-reported by the transport object. A hostile in-process double claiming `GLOBAL_FETCH` could forge a `REAL_NETWORK` capture origin. Production must source proofs from a trusted runtime that owns the transport. The positive-promotion test uses a stubbed global `fetch` and proves nothing about Stripe.
2. `verifiedMapping()` in `pipeline-fixtures.ts` is a TEST FIXTURE (fake proof lookup) used to exercise the legacy real-provider path; it must never ship as authority.
3. The authorization store is in-memory (dev). Production storage, key custody, and who may APPROVE are owner decisions; no migration was added.
4. SDK shapes come from stripe@22.3.2 types (API 2026-06-24.dahlia) and are shape evidence only, not live proof.
5. `expiry` mutation in the authorization loop is an equivalent mutant (`decideCapability` re-checks expiry with the same reason code: defence in depth).

## Merge order

#228 first, then retarget this PR to `main`. Stacked PRs do not run hosted CI; CI must be observed after retargeting.
