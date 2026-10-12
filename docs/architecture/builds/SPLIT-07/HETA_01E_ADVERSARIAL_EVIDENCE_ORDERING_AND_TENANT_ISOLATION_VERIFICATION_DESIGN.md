# HETA-01E — Adversarial Evidence, Ordering and Tenant-Isolation Verification Design

**ECHO GRID | Split 07/08 | Status: proposed documentation-only verification contract; NON-ACTIVATING.**  
**Base:** `main` @ `27d19c4fadf40341a49612cd21244465b4e44d2c` (HETA-01D merged).  
**Excluded:** Executable tests, application code, SQL/migrations, Cloudflare/Stripe settings, financial operations, deployment and economic activation.

## 1. Purpose and upstream authority

HETA-01B specifies immutable signed-event intake, tenant identity binding and quarantine; HETA-01C classifies candidate provider effective-time authority; HETA-01D specifies trustworthy completeness and nonoverlapping `[effectiveFrom,effectiveTo)` historical interval certification. HETA-01E specifies how to **attack those contracts** and prove fail-closed behavior before any implementation or positive historical tier decision.

Current `stripe-webhook.routes.ts` verifies the Stripe signature before processing; `stripe-webhook.service.ts` updates a mutable local subscription mirror before `stripe-subscription-history.recorder.ts` records limited observations. The existing recorder can skip valid but unmatched events; local mirror writes are not a trustworthy historical order source. `historical-effective-time-authority.review.ts` currently returns `historicalTierVerified:false` and `issuanceAuthorized:false`. Tests proposed here **must not be described as already executable or passed**.

Passing adversarial tests cannot invent provider transition-time semantics or prove completeness of external Stripe modification channels. These remain separately evidenced upstream conditions.

## 2. Threat boundaries and universal invariants

1. **Authenticated event != tenant ownership.** Independently bind business, Stripe account, livemode, customer, subscription, subscription item and versioned Price-to-plan policy. User-provided metadata/claims cannot establish authority.
2. **Recorded event != price-effective boundary.** `event.created`, receipt/processing timestamp, invoice period and schedule intent may not be used as effective time without HETA-01C source-specific proof.
3. **Adjacent transitions != complete history.** HETA-01D must establish a trusted coverage anchor, closure through authoritative Split 06 `fulfilledAt`, no missing external transitions, and deterministic nonoverlapping intervals.
4. **Fail closed.** Missing, ambiguous, unsupported, replayed, conflicting or improperly scoped evidence must not produce positive historical tier certification, Partner Credit issuance or redemption.
5. **Consistent snapshot and append-only audit.** Every hypothetical decision refers to immutable evidence IDs, binding/policy versions and supersession lineage; never mutate a prior certified result in place or reuse a superseded one.
6. **Independent domains.** Split 06 owns settlement fulfillment/reversal facts. Split 07 owns proposed earning and any eventual issuance after separately approved gates. Split 08 owns provider-verified invoice application and consumption. Business loyalty, orphan settlement value and Community Points are separate.
7. **No economic bypass.** Preserve PC-ECON/1 and PC-ECON/2-A01 proposal boundaries and economic write-denial migrations **0041, 0042, 0044** unchanged.

The statuses `CERTIFIED`, `INCOMPLETE`, `CONFLICTED`, `UNPROVEN` are **conceptual HETA-01D future decision outcomes**, not runtime rights. Under current authority gates positive `historicalTierVerified`, `issuanceAuthorized` and `redemptionAuthorized` remain denied.

## 3. Mandatory E01–E20 adversarial test catalogue

| ID | Injection / controlled fault | Expected assertable outcome |
|---|---|---|
| E01 | Replay authentic event with identical account/mode/ID/payload | Single canonical immutable inbox event; idempotent handling, no duplicated economic effect |
| E02 | Same event identity but conflicting digest/payload | Quarantine and integrity alert; never overwrite original |
| E03 | Deliver old event after a newer subscription state observation | Preserve both; never roll back reconciled projection based on arrival order |
| E04 | Remove intervening upgrade/downgrade evidence | Completeness failure; historical tier denied at affected fulfillment |
| E05 | Deliver event before server-owned identity binding or mirror exists | Restricted unattributed capture; no claimed tenant assignment or silent loss |
| E06 | Forge/mislead `metadata.businessId` toward another tenant | Verify authoritative binding; no cross-business attribution |
| E07 | Swap Customer/Subscription IDs between businesses | Quarantine identity conflict, no cross-tenant read/certification |
| E08 | Substitute Stripe test account or mode for live evidence | Reject as wrong account/mode |
| E09 | Supply stale `metadata.planId`, unknown Price ID, or ambiguous mapping | Deny price-to-tier certification |
| E10 | Create payment-pending upgrade that is unpaid, later paid, or expires | Pending request never treated as effective; prove actual applied transition or deny |
| E11 | Change/release schedule before intended phase executes | No historical grant from planned phase alone |
| E12 | Place settlement precisely at/near price transition with different clock resolutions | Half-open boundary only if ordering provable; otherwise deny |
| E13 | Construct contradictory overlapping tier intervals | `CONFLICTED`, no positive certificate |
| E14 | Create gap in claimed history coverage | `INCOMPLETE`, no positive certificate |
| E15 | Fail database transaction before durable signed-event capture commit | No successful durable-capture acknowledgment; retry without silent loss |
| E16 | Introduce contradictory evidence after earlier certification | Append-only supersession; invalidate affected future reliance, prevent stale decision use |
| E17 | Multi-item or unknown-price subscription, malformed period | Retain authentic raw event in restricted state; no supported historical tier |
| E18 | Inject client-provided “verified tier”/server decision token or forge scope | Server rejects client authority, validates authorization and evidence provenance |
| E19 | Race subscription replacement, identity-binding update and fulfillment | Same consistent evidence/identity snapshot or deny; no cross-subscription award |
| E20 | Replay settlement/certification or retry concurrent consumers | Deterministic idempotency, no duplicate earning/redemption/financial side effect |

## 4. Isolation verification — not helper-only

- Test API RBAC, tenant-scoped repository access and applicable PostgreSQL RLS with at least **two independently provisioned businesses**, branches and user roles; assert Business A cannot enumerate/read/mutate/certify Business B's Stripe evidence.
- Test application-to-DB bindings, tenant identifiers and privileged service entry points. Any legitimate service bypass of tenant RLS must be narrowly justified and audited, with explicit policy tests.
- Exercise tenant identity collision, malicious metadata, wrong business branch, cross-account and livemode mixing without disclosing another tenant's identifiers through errors or logs.
- Use isolated test Stripe resources / signed test fixtures. Never invoke live Stripe financial mutation, change production portal settings, or use production credentials.
- Demonstrate negative cases against actual auth/data paths and database policy, not merely pure classification helpers.

## 5. Event ordering and deterministic concurrency

Tests must control arrival, persistence, projection, binding and settlement steps with deterministic synchronization barriers: `capture -> identity bind -> projection`, concurrent repeat deliveries, older webhook after newer, DB failure after capture but before reconciliation, two provider transitions in one period, and contradictory evidence arriving while certification is formed. Randomized permutations are additional defense, not a substitute for reproducible interleavings.

Bind each hypothetical certification to an immutable evidence-set digest, policy mapping version, completeness/coverage attestation and authoritative `fulfilledAt`. Validate no time-of-check/time-of-use reuse of superseded, quarantined or subsequently contradicted decisions; a later transition must not retroactively reprice earlier settlement.

## 6. Evidence package for future execution

For every E01–E20 case, require: test fixture/version, threat rationale, exact input provider objects and IDs (redacted where necessary), auth principal and tenant, Stripe account/mode, delivery order, deliberately controlled clock/boundaries, expected `CERTIFIED/INCOMPLETE/CONFLICTED/UNPROVEN` conceptual class, actual outcome, immutability/duplicate assertions, no-credit side-effect assertions, evidence IDs/digests, logs, migration versions, test DB endpoint class, source commit SHA and reproducible invocation.

Record a failure as a failing test, never as a skipped pass. Document intentional unsupported paths as explicit negative assertions. Test environments must be disposable and identifiable; CI must not inherit production financial authority.

## 7. Admission/exit criteria

- **Design admission:** Source evidence of each enabled Stripe mutation surface and HETA-01B/C/D accepted assumptions; any missing provider-effective timestamp or incomplete coverage remains `UNPROVEN`.
- **Implementation candidate:** Separate HETA-01F review of proposed additive DB changes, migration 0043 coexistence, existing billing behavior, CI/disposable PostgreSQL, rollback and safety. No tests or migrations included in HETA-01E PR.
- **HETA-01E future test acceptance:** Every E01–E20 case executes and reports expected negative-path outcome where applicable; deterministic concurrency and real tenant/RLS policies are exercised; adverse cases cannot produce a certified tier or financial effect.
- **Independent HETA-01G review:** Architecture, security and economic reviewers inspect implementation evidence, provider effective-time semantics, coverage closure, identity isolation and preserved write-denial triggers before any separate authorization.

**Disposition:** Documentation-only test specification; no positive provider-history authority, issuance, redemption or activation is conferred. Stop before executable tests, schema design, application changes or merge without separately requested permission.
