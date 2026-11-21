# NETWORK-15-T2 — independent terms foundation; activation integration blocked

Date: 2026-11-21. Baseline: `4f16dfc00f882c4543a89b9aa91ff461fc879d43`.
PR #552 is merged. The isolated T2 branch started at that exact main commit.
No open PRs or repository approval of `NETWORK-15-T2-D1` were found at inspection.
The supplied continuation explicitly says it is **not** D1 or legal approval.

## Decision boundary

**NETWORK-15-T2-D1: PROPOSED — NOT APPROVED.** This identifier is distinct
from T1 D1 (free/voluntary membership), which is also not newly approved here.

Proposed ruling: platform Restore may clear moderation restrictions but may not
fabricate consent, override voluntary Leave, reactivate without valid current
consent/verified phone, bypass bans or resurrect membership through a Leave race.
Legacy customers without consent evidence need explicit effective-terms acceptance
before consent-dependent activation. This is recorded for decision, not enforced
as an approved change to existing Restore semantics.

Owner must approve/reject that ruling and resolve the representation/sequencing
of moderation clearance, retained voluntary intent and renewed acceptance for
stale/missing evidence. The current paired state machine has active, left and
suspended membership; a suspended customer cannot Join/Rejoin. Do not infer that
clearance means voluntary Leave, add a new state, or silently restore activation.

## Implemented independent scope

`apps/api/src/community/community-terms-authority.ts` is an **unwired foundation**.
No handler, membership service, Restore writer, UI, middleware or scheduled job
imports it. Its shipped source returns no publication, so its resolver fails
closed. There is no registry database adapter, publication endpoint, approval
operator, feature switch, new permission or approved record. This is functional
validation code with unit coverage, not a deployed terms registry or completed T2.

The server-source interface supplies one current pointer/publication snapshot.
The resolver validates approved state/reference/time, publication and effective
times, pointer identity, bounded exact content and hashes. Missing data, outages,
missing schema and malformed records produce only 503 `COMMUNITY_TERMS_UNAVAILABLE`.
Future publications/approvals, superseded or draft records are refused. No legal
translation fallback is selected: the requested reviewed artifact must exist.

SHA-256 uses exact UTF-8 artifact bytes without newline or Unicode normalization.
The manifest is the JSON encoding of the fixed tuple:

```text
["community-terms-manifest/1", purpose, publicationId, version,
 publishedAt, effectiveAt, sorted [[locale, contentHash], ...]]
```

Sorting is locale code-point order, not environment-dependent collation. Every
artifact hash and the stored manifest binding must match. The closed frozen view
contains only publication ID, version, effective timestamp, locale, exact content,
artifact hash, manifest hash and algorithm. Approval references/internal source
fields are not returned. Zod parsing copies source values before hashing awaits.
These checks detect inconsistent snapshots; durable published-record immutability
and globally current publication are **not established without persistence**.

The strict pure acceptance precondition validator requires literal true, matching
publication/version/manifest/artifact/locale, the server lifecycle basis, Join or
Rejoin operation and a bounded request key. It rejects extra identity, timestamp,
approval and legacy `policyVersion` fields. It creates no evidence, acceptance
time, grant, customer, membership, account or point transaction. It is not an
authentication, moderation, idempotency or transaction boundary.

## Persistence, locking and remaining integration

No migration or schema change is introduced/reserved. The inherited journal ends
at `0087_customer_pending_registration`; 0080–0087 remain unchanged. The mutable
`consent_grants` CHECK still lacks the Community purpose. Existing append-only
`audit_log` and its staff-only actor FK remain unchanged. No second consent ledger
is created; no legacy acceptance is synthesized.

After the decision, implement the reviewed additive registry/current pointer and
consent-purpose extension. Coordinate source resolution and acceptance under
database locks: current-pointer shared lock, then customer, then account. A
publication change needs the pointer's exclusive lock without customer/account
lock inversion. A read-only source snapshot outside that transaction cannot prove
currentness through activation. Do not wire this resolver to activation on that
basis. Registry approval/publication write privileges require separate review;
customer input can never implement the trusted source interface.

Create/revoke the consent lifecycle projection and mandatory immutable audit
event in the membership transaction; propagate all failures. Database acceptance
time, server IDs, customer-scoped replay binding and deterministic lifecycle
basis are unimplemented. Preserve the established post-commit award reevaluation
and locked-active-account award/Leave correction. No economics or balances change.

## Existing API and legacy compatibility

The current customer Join endpoint still accepts a policy-version string and
does not enforce the new consent contract. Low-level Join remains unchanged.
Platform Restore still transitions paired suspended membership/account to active
under `community:adjust`, records its existing semantic audit and preserves balance.
**These gaps are not fixed by the foundation. Do not declare T2 secure/complete.**

| Existing legacy state | This change's behavior |
| --- | --- |
| Active, no evidence | Unchanged; no fictional consent or new Feed gate |
| Suspended, no evidence | Existing Restore unchanged; D1 treatment blocked |
| Voluntarily left | Existing explicit rejoin behavior unchanged; no new activation |
| Earlier valid/stale evidence | No new interpretation or reacceptance policy |

Customer UI remains the NETWORK-15 disabled Join/Rejoin foundation, verified-phone
handoff and confirmed Leave. Feed still requires authoritative verified phone
under the rejected N14-READ-01 ruling. Business loyalty and Community Points stay
separate. No customer authentication, phone OTP, moderation powers, privacy runtime,
B2B or billing implementation is modified.

## Verification and limits

The new tests import the actual foundation, not a stand-in state machine. They
cover missing/unapproved/future/mismatched source records, exact artifact and
manifest hashes, translation handling, closed responses, explicit acceptance,
forged fields, stale bindings and lifecycle bases. Synthetic approval exists only
inside tests, never in a runtime catalog. T1's 20 reference-model tests remain
separately labeled and unchanged. Existing Community/Network PostgreSQL and browser
suites characterize retained behavior; they do not prove the unimplemented atomic
T2 activation or Restore cases. Exact counts and hosted outcomes belong in the
PR/completion evidence, not an inferred success statement here.

The 24 full T2 database security/concurrency cases and eight conditional Restore
cases remain blocked/not implemented. No approved Join/Rejoin browser flow exists.
Passing foundation tests or existing regressions does not satisfy the full T2 DoD.

## Release and rollback

This foundation has no integration or persistence effects to activate/roll back.
Removing it and its tests leaves all existing routes unchanged. Terms publication,
legal/localization review, privacy/retention review, D1 approval, additive schema
and runtime privileges, all-gateway atomic enforcement, actual concurrency/browser
proofs and separate deployment/activation authorization remain prerequisites.
Merging this partial draft approves none of those gates. No shared database,
secret, infrastructure, legal draft or live consent is modified.
