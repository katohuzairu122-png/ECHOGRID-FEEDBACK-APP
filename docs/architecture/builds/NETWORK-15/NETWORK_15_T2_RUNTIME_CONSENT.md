# NETWORK-15-T2 — runtime membership consent and Restore safety

Development only. Baseline `aa7c016b7a3cd4aca4769414b4f18242ea2cc7fe`.
NETWORK-15-T1 #552 and the inactive foundation/D2 harness #553 are merged.
The Owner approved the previously proposed D1 development contract in this
conversation on 2026-11-23; see [the exact ruling](NETWORK_15_T2_D1_APPROVED.md).
This supersedes the historical “unapproved / unwired” implementation status in
previous revisions of this technical document, without approving legal terms.

**No approved publication is shipped. No legal version/effective date, shared
migration, deployment, live consent or live enrollment is authorized here.**

## Architecture and states

| Membership | Meaning | Community account | Customer transition |
| --- | --- | --- | --- |
| absent | No enrollment | No account created by reading | Explicit Join |
| active | Voluntarily enrolled; new activations have immutable acceptance | active | Confirmed Leave |
| left | Voluntarily terminated | closed; balance/history retained | Fresh explicit Rejoin |
| suspended | Moderation blocks customer changes | suspended | Authorized platform clearance only |
| inactive | Moderation cleared, current acceptance missing/stale | closed; balance/history retained | Fresh explicit Rejoin or confirmed Leave |

`inactive` implements D1's already-approved inactive outcome inside the existing
state machine; it is not voluntary Leave, and Restore does not invent `left_at`.
Platform suspension can also restrict an inactive member before fresh acceptance.
Existing permission `community:adjust` remains the only platform transition power;
customer phone assurance is never a moderator permission.

Legacy active rows are not backfilled, silently suspended or falsely marked as
accepted. Already-active material-change enforcement remains a separate policy.
Legacy suspension restores to inactive without evidence; fresh explicit acceptance
then reuses the original membership/account. Known earlier membership dates and
policy labels are recorded as *prior observations*, not historical consent proof,
before a real transition replaces mutable current-state fields.

## Registry and schema

Additive development migration `0088_community_membership_consent` follows 0087.
It adds two platform-global terms tables, a nullable current pointer initialized to
NULL, the Community consent purpose and the inactive state CHECK extension. No
customer/account/balance/acceptance is backfilled. Merged migrations are unchanged.

- `community_terms_publications`: version-unique records binding ID, purpose,
  localized exact text, approval state/reference/time, publication/effective times
  and immutable SHA-256 artifact/manifest hashes.
- `community_terms_current`: one purpose-specific current pointer. Its guard
  requires an approved published effective record before a non-null target.
- ALWAYS triggers prevent published record UPDATE/DELETE/TRUNCATE and current
  pointer deletion/truncation. Current-pointer mutation takes the exclusive global
  advisory transaction lock. No runtime publication/approval endpoint exists.
- Runtime privilege manifest adds **SELECT only** on these two Community tables;
  its generated SQL changes no other table's authority. No shared provisioning is
  run. Publication requires a separately authorized schema-owner/operator process.
- Community request-key digests live in grant metadata, protected by a dedicated
  customer-scoped unique expression index. They do not occupy the legacy global
  `idempotency_key` namespace. Other purposes and economic services are unchanged.

The existing terms validator checks exact UTF-8 bytes without newline or Unicode
normalization. The canonical manifest is the JSON tuple
`["community-terms-manifest/1", purpose, id, version, publishedAt, effectiveAt,
sorted [[locale, contentHash], ...]]`, sorted by locale code-point order. Every
artifact/hash is validated; no unreviewed translation fallback is allowed.

The generated Drizzle snapshot is compact JSON; the custom index/ALWAYS guards
are explicit SQL in the same migration. The snapshot and `db:check` remain current.

## API contract and safe DTOs

All customer endpoints remain under `/api/v1/community/me` with actual customer
middleware/current identity and existing customer-scoped rate limiting.

- `GET /`: existing closed membership/account DTOs; inactive is now recognized.
- `GET /terms?locale=en|fr|es|ar`: `{offer:null}` if no valid effective artifact is
  available, otherwise `{offer:{terms,operation,transitionId}}`. Terms expose only
  publication ID, version, effective date, locale, text, content/manifest hashes
  and algorithm. Approval references/internal data never appear in that DTO.
- `POST /join`: strictly accepts the following fields. No legacy version-only
  fallback, identity, verification, approval, grant/audit ID or client timestamp.

```json
{
  "operation": "join",
  "consentAccepted": true,
  "expectedPublicationId": "<server-displayed UUID>",
  "expectedTermsVersion": "<server-displayed version>",
  "expectedTermsHash": "<manifest SHA-256>",
  "expectedArtifactHash": "<locale artifact SHA-256>",
  "displayedLocale": "en",
  "expectedTransitionId": null,
  "idempotencyKey": "<bounded request key>"
}
```

The expected values are stale-view preconditions, never authority. Rejoin uses the
same endpoint with `operation:rejoin` and the current server lifecycle basis.
The result includes the existing status/account summary, created/reactivated flags,
minimal consent version/server time/transition reference and the actual number of
pending awards released by the existing post-commit reevaluation.

- `POST /leave`: existing authenticated explicit Leave; body assertions never
  choose another customer. It closes the account, revokes Community projections
  and appends a mandatory lifecycle event, preserving previous audit/ledger data.
- The existing owned-consent withdrawal flow maps the Community purpose to this
  same atomic Leave. Another customer's grant cannot be revoked. Suspended-state
  restrictions remain. The generic grant wrapper refuses this dedicated purpose.

Authentication/session failures use existing 401s; customer status and phone are
also revalidated under lock. Phone denial is 403 PHONE_VERIFICATION_REQUIRED;
suspension remains 409 COMMUNITY_MEMBERSHIP_SUSPENDED; terms unavailable is 503
COMMUNITY_TERMS_UNAVAILABLE; invalid explicit consent is 400; stale publication,
lifecycle or request binding is 409 COMMUNITY_ACCEPTANCE_STALE. HTTP schema parsing
rejects extra/legacy fields before domain execution. Storage errors never become
customer-visible SQL/private metadata. Missing registry schema fails closed.
Leave does not query the registry and remains usable without the new tables.

## Transaction, evidence and concurrency

1. Take shared advisory transaction lock on `community_membership_terms_current`.
2. Lock the authenticated customer row FOR UPDATE; revalidate active identity and
   actual verified phone, then membership/account moderation eligibility.
3. Resolve the current immutable publication through the transaction's real DB
   adapter and check exact acceptance, operation and lifecycle basis.
4. Inspect only this customer's Community request digest. Matching current replay
   returns the original evidence. A stale key/basis cannot resurrect Leave.
5. Create/reactivate the existing membership/account and create the Community
   grant projection plus mandatory append-only audit acceptance inside one TX.
6. Commit, then retain the existing pending-award reevaluation. A post-commit
   award failure does not fabricate another acceptance on retry.

Publisher mutation takes the exclusive counterpart; consumers hold shared currentness
through commit. Publisher takes no customer/account lock, so there is no reverse
lock ordering. Leave/withdrawal take customer then account and need no publication
lock. The existing award/Leave locked-active-account revalidation is untouched.

Immutable audit evidence binds authenticated customer, membership, grant,
Join/Rejoin operation, exact publication/version/manifest/artifact/locale,
server-generated acceptance time and correlation/transition IDs. Prior observations
are explicitly not previous acceptance. It excludes phone/email/name, credentials,
IP/UA and raw request keys. Customer events use null staff actor because that FK
belongs to staff users. Audit failure propagates and rolls back all writes.

The existing grant is a revocable projection, not immutable history. Its exact
binding must match the immutable event to authorize Restore. Leave revokes rather
than deleting it. A deterministic per-membership event sequence and previous UUID
provide lifecycle ordering under the customer lock, independent of timestamp ties.
No parallel consent ledger or financial earning rule is introduced.

## D1 Restore

Restore takes registry shared lock before customer/account locks, checks current
customer and phone eligibility, then the existing paired state invariant.
Valid current grant **and** matching immutable evidence permit active/active.
Missing/stale evidence or unavailable approved terms clear authorized moderation
into inactive/closed. A savepoint prevents a terms read failure from poisoning the
clearance transaction. Missing new schema fails closed before any activation.
No evidence is invented by staff. Left state cannot be restored. A successful
Leave serialized with Restore remains left; suspended Leave still follows the
existing denial rule. Platform semantic audit failure rolls back both statuses.

## Customer interface

One Community tab remains, with Points & Membership and Feed. The membership
section reads a locale-specific approved offer, displays exact version/effective
time and accessible plain text, and starts with unchecked acceptance. Unavailable
terms keep Join/Rejoin disabled. Phone handoff uses the existing account route,
never sends SMS on page load and never treats returning as verification or consent.
Server Actions reject duplicate/extra fields and rely on API enforcement, not
client flags. Pending submission disables duplicates; stale terms require refresh
and new acceptance. Success refreshes authoritative membership/points; the UI never
calculates/issues points. Confirmed Leave and inactive-member cancellation remain.
English/French/Spanish/Arabic RTL and existing responsive design are preserved.
UI translations are not native-speaker/legal approval of future terms artifacts.

## Verification and release limits

Tests use synthetic reviewed-looking publications **only in loopback disposable
PostgreSQL**. Existing positive service fixtures now construct real explicit
acceptance through the actual runtime, rather than calling a legacy bypass.
Unit/model tests remain separately labeled; old inert-only source guards are
superseded by real empty-registry/strict-boundary regressions, not suppressed.
Tests cover atomic failure rollback, six-way Join/Rejoin, stale publication under
observed advisory contention, cross-domain key collision (red before correction),
old-schema availability, role/session/customer isolation and every D1 outcome.
Existing Network pinning, pagination, Feed projection, moderation and financial
compatibility suites remain. Final exact counts/browser/CI evidence belong in the
PR/completion report. No skipped case is a pass. Local Chromium download was
blocked; the hosted real-Chromium workflow is required before merge readiness.

Activation still needs separately approved legal text/localizations/version/date,
privacy/retention and publisher/operator review, reviewed migration/runtime
provisioning and explicit deployment/activation permission. No approval is implied
by green CI, this technical document or merging code.

Rollback must preserve additive schema and immutable evidence. Old clients using
bare policyVersion intentionally fail closed. Older applications may not recognize
inactive; do not rewrite it as voluntary Leave or delete consent to roll back.
Use a reviewed compatible forward fix/controlled release plan. No rollback or
shared-environment change is executed by this development work.
