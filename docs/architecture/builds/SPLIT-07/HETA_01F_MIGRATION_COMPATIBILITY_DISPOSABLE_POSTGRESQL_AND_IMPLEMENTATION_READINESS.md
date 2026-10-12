# HETA-01F — Migration Compatibility, Disposable PostgreSQL Verification and Implementation Readiness

**Status:** Documentation-only implementation-readiness proposal. **NON-ACTIVATING**.  
**Base:** `main` @ `12dbfdce3aaa9c720f094a3f5b3f417600202aed` (HETA-01E merged).  
**Not authorized:** SQL, code, test execution, migration execution, production changes, Stripe writes, positive historical-tier certification or Partner Credit issuance/redemption.

## 1. Dependency contract

- HETA-01B defines provider event inbox, immutable identity binding, quarantine and replay semantics. Current Stripe webhook flow updates the subscription mirror before the 0043 observation recorder, and the recorder skips events when the mutable mirror does not match. An eventual implementation must close that gap without dropping evidence.
- HETA-01C classifies source-specific effective-time evidence for Checkout, immediate/pending updates, Portal, external Dashboard/API changes, schedules and cancellation. **No universal Stripe event timestamp is certified.**
- HETA-01D defines evidence coverage, completeness and nonoverlapping half-open price-effective intervals, with independently proved coverage anchors, versioned mapping and append-only supersession.
- HETA-01E defines the 20 adversarial cases E01–E20, including tenant/RLS, replay, ordering and concurrency. This document is a readiness contract only; it does **not** claim those tests execute.
- Billing current-state projection, subscriptions, customer identities, Stripe 0043 append-only observations, tenant RBAC and migrations 0041/0042/0044 must remain compatible and remain protected.

## 2. Sequenced additive implementation proposal — separate future approvals per phase

**F0 — inventory and baseline:** Freeze current schema and migration checksum inventory, Stripe SDK/API version, webhook endpoint configuration and idempotency behavior, auth/RLS assumptions, provider scope and external Portal/Dashboard/API mutation controls. Record source commit, local and disposable database versions. Confirm existing CI and prior tests baseline before writing code. Unresolved origin coverage blocks positive authority.

**F1 — authenticated durable event inbox and quarantine:** Propose append-only table(s) for signed provider event and disposition log, scoped by Stripe account + livemode + event ID, with deterministic payload digest, original event integrity/provenance, time distinctions, idempotency and restricted access. Before implementing, separately approve exact storage, encryption, retention, audit, transaction/ack, RLS and recovery design. Do not replace or rewrite migration 0043.

**F2 — authoritative tenant/customer/subscription identity binding:** Additively model verified ownership, bootstrap/replacement and binding lifecycle, enforce cross-tenant and account/mode constraints, prohibit metadata-only reassignment. Record disputed/unknown events in restricted quarantine without treating them as another tenant's history.

**F3 — safe subscription projection:** Separate durable capture from reconciliation. Design/review transaction, retry and source ordering behavior so stale webhook snapshots cannot regress current subscription state or cause false tier history. Preserve existing billing route RBAC and current operational behavior. Do not infer effective time from receipt order.

**F4 — transition candidates and interval review:** Only after HETA-01C provider operation semantics are independently evidenced, design append-only transition candidate and audit supersession models. Do not promote a signed event to certified price-effective history without HETA-01D coverage closure. Version Price-to-plan mappings and evidence sets.

**F5 — negative-path validation:** Implement E01–E20 as a later independent test block against actual auth, repositories and disposable PostgreSQL RLS, with deterministic concurrency barriers. Separate source assertion correctness from provider-side coverage proof.

**F6 — limited enablement review:** No rollout, issuer integration, ledger write, discount application or trigger changes without separate sign-off and explicit owner authorization. Any proposed positive certification API must be isolated and not activated by schema or test readiness alone.

## 3. Migration compatibility and data invariants

- **Additive only:** New structures/migrations may be proposed in a future PR; never rewrite 0043 observations, existing subscriptions, financial movements or applied migration files. Reconcile exact next migration number against live `main` before implementation.
- Preserve `business_subscriptions` as current-state projection and preserve the immutable observation semantics of `stripe_subscription_tier_observations`. No automatic backfill may fabricate verified event capture, attribution, effective boundaries or completeness.
- Every proposed table requires explicit tenant visibility and service authority review, foreign-key/delete behavior, unique scoped provider identity, indexes, append-only enforcement, null/unknown-state semantics and transaction/isolation strategy.
- Separate `event.created`, database receipt/commit timestamp, processing timestamp, candidate price-effective timestamp, and Split 06 authoritative `fulfilledAt`. Avoid timezone and precision ambiguity at boundary comparisons.
- Schema `NOT NULL` fields must not make authentic but unattributed/malformed evidence disappear. Restrict quarantine records and design privacy-preserving retention.
- For migration 0043, prove additive coexistence, replay/backfill safety, existing consumer and read-path compatibility; any behavior change needs targeted regression coverage and explicit review.
- Economic guards **0041, 0042, 0044 remain installed and enforced** under all versions, accounts, branches, users and adversarial test modes.

## 4. Disposable PostgreSQL and CI acceptance matrix

| Gate | Required evidence in a later executable block |
| --- | --- |
| Schema reproducibility | Clean disposable PostgreSQL provision, migrations applied in numerical order, matching checksums and schema introspection |
| Existing-DB upgrade | Restore sanitized prior schema/state; additive migrate and verify retained subscription/0043 evidence |
| RLS isolation | At least two businesses/branches/users, explicit app and database roles, cross-tenant read/write denials and audited privileged paths |
| Immutable provider evidence | Insert/replay/conflicting digest/quarantine/append-only mutation rejection; no metadata-only tenant attribution |
| Stripe flow compatibility | Checkout, Portal entry points, signed webhook handling, retry and billing latest-state behavior unchanged until explicitly reviewed |
| Event ordering | Reverse, duplicate, omitted and race-interleaved events; no stale projection rollback |
| Historical coverage | Missing source/transition, unproven effective time, ambiguous boundary and superseded records all fail closed |
| Safety guards | Inspect 0041/0042/0044 triggers and attempt forbidden financial writes under scoped test identities; all denied |
| Migration rollback | Test forward/compensating strategy on disposable DB; no destructive downgrade of evidence; document repair and stop conditions |
| Baseline CI | Typecheck, migration check, existing automated tests and E01–E20 new tests (when authorized), with recorded outcomes |
| Operational resilience | DB outage/no false ack, retry saturation, bounded DLQ, replay recovery, metrics and audit trail |
| Environment isolation | No production DB/Stripe credentials, live customer records or billed operations |

**Evidence format:** commit SHA, migration names/checksums, disposable database and runtime versions, exact commands, pass/fail logs, SQL constraint/trigger introspection, test counts, unresolved findings and reviewer sign-off. CI green by itself does not certify Stripe effective-time semantics.

## 5. Recovery, rollback and containment

Prefer feature-flagged internal ingestion with denied economic consumers, but do not assume a flag overrides database protections. On failed additive migration or incorrect attribution, cease processing, preserve signed raw evidence and audit trail, prevent new positive decisions and apply a separately reviewed compensating forward migration rather than silently dropping or editing evidence. Reconcile replay idempotently after repair. Define ownership, incident thresholds and procedure to revoke/supersede a previously issued certification in the future; no historical financial rewrites are allowed under this spec.

## 6. Decision and blockers

**Design readiness only.** Before code/migration authorization, require evidence that exact Stripe price-effective transition semantics can be proven for enabled change paths, closure of history coverage including out-of-band changes, verified immutable account/customer/subscription/business binding, approved SQL/RLS/retention and consumer contracts, and successful E01–E20 disposable-environment verification. HETA-01G must independently review architecture, security and economics. A failed gate stops progression.

**Authority:** `historicalTierVerified:false`, `issuanceAuthorized:false`, and `redemptionAuthorized:false` where defined. Preserve Split 06 (fulfillment), Split 07 (earning), Split 08 (invoice application), PC-ECON/1 vs proposed PC-ECON/2, Community Points segregation and migrations 0041/0042/0044.

**Stopping point:** Documentation-only implementation-readiness proposal. No implementation, executable tests, migration application, merge or activation approved.
