# Community membership consent contract — proposed, non-activating

> Historical T1 proposal. The final T2 Owner dispatch supersedes conflicting technical
> implementation/Restore statements: every Restore requires fresh customer consent;
> prior consent is never reused. See [the current D1 ruling](../../NETWORK-15/NETWORK_15_T2_D1_APPROVED.md)
> and [runtime contract](../../NETWORK-15/NETWORK_15_T2_RUNTIME_CONSENT.md).
> Legal terms and live activation remain unapproved.

**Status: DESIGN ONLY — NO APPROVED TERMS — NO RUNTIME ACTIVATION.**
Baseline: `f2f9212d502607ee24af203dcb2fcf865a55b8ad`.
Candidate identifier: `community-membership-v1.0`; approved/effective version: none.

## 1. Reconciliation and reuse

Existing Community routes at `/api/v1/community/me` support status, `/join` and
`/leave`. `CommunityMembershipService` locks the customer row, maintains one
membership/account and preserves history on left/reactivation. `/join` presently
accepts an arbitrary bounded nonempty `policyVersion`, then reevaluates pending
awards after membership commit. It does not verify approved terms or create
versioned Community acceptance evidence. NETWORK-15 disables new customer UI
Join/Rejoin; it did NOT close that legacy API contract gap. Do not report the
model tests here as runtime enforcement of the proposed contract.

Existing business loyalty uses explicit `consentAccepted` and approved shipped
versions in `packages/shared-types/src/customer-relationships.ts`, with
`CustomerMembershipService` and `ConsentGrantRepository`. Reuse its validation,
customer-scoped idempotency and DTO patterns, not its business purpose or `v1`
value as Community approval. Business terms and memberships are separate.

`consent_grants` currently permits only `join_loyalty`, `marketing`,
`survey_participation`, `settlement_access`, `contact_sharing`. It cannot store a
`community_membership` purpose without a separately approved CHECK/type change.
Its lifecycle/metadata/version fields are mutable, and customer deletion has a
cascade FK: a grant alone is not immutable historical acceptance evidence.

Reuse `consent_grants` as the lifecycle projection, plus existing append-only
`audit_log` as mandatory acceptance/transition history. Do not introduce a second
consent ledger, borrow `join_loyalty`, or hide Community consent inside marketing
metadata. `audit_log.actor_user_id` references staff `users`, not customers: leave
it null for a customer action and bind the authenticated pseudonymous customer ID
explicitly in the closed event payload. Never substitute a customer ID for a
staff actor. Existing `AuditLogRepository.recordReturningId` can be called inside
the domain transaction; do not rely on `auditTrail`, whose customer success path
may no-op and whose audit failures are intentionally best effort.

Existing `/terms` and `/privacy` use `LegalPage` with a hardcoded global effective
date, not a Community version registry or immutable approved artifact. Reuse the
accessible layout pattern only after approval; never copy its date into this
candidate. General service-use acceptance is not Community enrollment consent.
Existing localized membership components use en/fr/es/ar and RTL.
No new public terms route or mutation endpoint is implemented by T1.

## 2. Authority and publication

The server, not a request version, resolves one approved currently effective
publication for purpose `community_membership`. The publication is an immutable
record of version, artifact/content hash, localized artifact hashes, effective
instant and approval references. A changed translation requires a new approved
publication/content binding; a previously accepted version must remain retrievable
as an immutable artifact. Missing translations cannot silently fall back to
unreviewed legal text. Legal decides whether any reviewed fallback is acceptable.

Recommendation for a future approved implementation: a narrowly scoped terms
publication registry and current-publication pointer, with immutable artifacts
stored through approved versioned publication infrastructure. No equivalent
current registry was found. A terms catalog is not a parallel consent store.
Its persistence, constraints, publisher authority and runtime read privileges
require separate architecture/migration approval; T1 reserves no migration number.
Do not repurpose financial policy, B2B terms or privacy retention registries.

Currentness must be coordinated across Worker instances and rolling releases;
a code constant/env flag alone is insufficient to prove a globally current
publication. The future enrollment transaction takes a shared lock on the
resolved current-publication pointer, then the existing customer row lock.
Publication changes take the pointer's exclusive lock and no customer/account
lock. Customer -> account ordering stays intact; no account -> customer inversion.
This lock protocol, privileges and registry design must be reviewed before code.

Hash exact published artifact bytes with SHA-256; record algorithm and encoding.
For a multilingual bundle, bind a canonical manifest of each approved locale's
exact artifact hash and the displayed locale/hash in acceptance evidence. Avoid
self-referential hashes and ad-hoc JSON/key/newline normalization. Repository draft
file hashes used by tests are integrity observations, not legal approval or an
active terms catalog. Effective dates are server/database instants, never client
clock values; no date is selected in T1.

## 3. Proposed request and safe response (not mounted)

```json
{
  "operation": "join",
  "consentAccepted": true,
  "expectedTermsVersion": "<version actually displayed>",
  "expectedTermsHash": "<displayed artifact binding>",
  "expectedTransitionId": "<server-issued lifecycle basis or null>",
  "idempotencyKey": "<bounded request key>"
}
```

Strictly reject extra fields, including `customerId`, `businessId`, `verified`,
`acceptedAt`, `auditId`, `grantId`, `membershipId`, approval flags and permissions.
The expected version/hash/basis are stale-view preconditions only; they never
select an unapproved version, prove identity or authorize a transition. Require
literal boolean true, not a truthy value or a server default. The same guards
must cover every customer enrollment gateway; the legacy bare `policyVersion`
path must fail closed when the approved contract is integrated, not remain a bypass.

Response recommendation: closed membership status/reference, server accepted
version/time, existing account summary and actual released-award count only if
that post-commit effect has completed. Do not expose raw consent/audit metadata,
request-key digests, credentials, contact data or unrelated tenant records.
A 200/idempotent reply must refer to the committed original transition; a repeat
request is not another acceptance or another award issuance.

Suggested future errors: authentication uses existing 401; phone uses existing
403 `PHONE_VERIFICATION_REQUIRED`; suspension uses existing membership denial;
no effective approved terms -> 503 `COMMUNITY_TERMS_UNAVAILABLE`; missing explicit
acceptance -> 400 `COMMUNITY_CONSENT_REQUIRED`; unapproved/unknown version -> 409
`COMMUNITY_TERMS_MISMATCH`; changed terms or lifecycle basis -> 409
`COMMUNITY_ACCEPTANCE_STALE`; same request key with different bindings -> 409
conflict. These are proposed contracts, not new live error responses.

## 4. Minimal evidence and atomic transaction

| Evidence | Authoritative source / binding |
| --- | --- |
| customerId | Current authenticated active customer, revalidated under lock |
| membershipId | Existing/reused membership row, not a request field |
| transitionId | Server-generated unique append-only audit event ID |
| previousTransitionId | Last committed lifecycle event/basis |
| operation | Server-validated join or rejoin for the current state |
| termsVersion + publicationId | Locked approved/effective publication |
| contentHash + hashAlgorithm | Exact immutable artifact/bundle |
| displayedLocale + artifactHash | Reviewed wording shown and accepted |
| acceptedAt | Database transaction clock; not a client value |
| consentAccepted | Explicit validated true for this operation |
| consentGrantId | New projection row linked to this acceptance event |
| auditCorrelationId | Trusted server-generated correlation ID |
| requestBindingDigest | Customer + operation + publication/hash + basis + request key |

No phone number, email, name, password, OTP, access/refresh token, raw request,
client IP or user agent is needed in this new evidence. Existing platform security
logging remains independently governed. A customer UUID is pseudonymous, not
proof that a record is anonymous or exempt from privacy review.

Under the locked publication and customer transaction: revalidate active identity,
verified phone and membership/account moderation state; validate request and
publication/basis; inspect scoped idempotency binding; create/reactivate the
existing membership/account using established behavior; create the consent
projection with an explicitly approved new Community purpose; insert the mandatory
append-only acceptance/transition audit event; commit all or none. Preallocate
server IDs to cross-reference the grant and event without a second consent store.
An audit/evidence insert failure MUST abort, not be swallowed or deferred through
`waitUntil`. Set middleware audit suppression only after this semantic event commits.

The publication purpose/type/CHECK extension, evidence bindings, customer-facing
DTO implications and registry schema are BLOCKED on approval. No migration, grant,
new purpose value, API handler or production repository change ships in T1.

## 5. Idempotency, leave/rejoin and stale requests

Scope request authority to the authenticated customer and exact operation,
publication/hash and lifecycle basis. Reuse the consent repository's uniqueness
and authority-match pattern, extending comparison to content/transition bindings
in the future reviewed implementation; the existing helper alone does not check
all proposed metadata. A key collision must never return another customer's grant.
Serialize competing transitions with the existing customer lock. Matching replays
return one committed acceptance; different keys while already active do not create
extra consent records or claim a new transition. No ledger award is duplicated.

Every future Leave must atomically revoke the relevant current projection and
append a lifecycle event while preserving immutable prior acceptance and ledger
history. Rejoin requires a new current-version action based on that new lifecycle
basis. A cached old Join key/checkbox must not reactivate a left member. The event
chain/basis needs deterministic ordering independent of millisecond truncation or
transaction-start timestamps. Its uniqueness/order constraints are an implementation
review gate; do not infer current history from a mutable `policyVersion` alone.
Legacy rows without evidence remain explicitly legacy/unknown: never synthesize
historic acceptance, dates or hashes. Any baseline provenance event must say it
is a state observation, NOT consent.

Pending-award reevaluation remains the existing post-commit operation, under its
own established exactly-once evidence/ledger constraints and NETWORK-15's locked
active-account revalidation. A retryable post-commit failure must not create a
second membership/consent; a concurrent Leave must not allow credit into a closed
account. Do not fold in new amounts, rules, rewards, notifications or business
loyalty changes. Approval of this contract does not authorize financial activation.

## 6. Privacy, retention, legal and release gates

0085 enforces audit append-only history. 0086 retains identity-free customer shells
and existing immutable evidence; it does not authorize rewriting audit history.
Reuse those boundaries, minimize new payloads and require privacy-owner review of
new references/purpose retention before activation. Consent lifecycle updates and
customer cascade behavior mean the immutable event must remain sufficient to
interpret its historical artifact binding after projection deletion/anonymization.
No retention period, erasure exemption, lawful basis or automatic legal hold is
invented. No D2 implementation or privacy operation is modified by this design.

Material-change reacceptance for active members is unresolved. Do not implement
an implicit new Feed gate or auto-suspend/forfeit balances. If approved later,
use a distinct explicit acceptance transition preserving earlier events; no old
grant or acceptance row is edited into evidence of a new version.

Activation requires Owner/legal decisions, reviewed localization/publication,
separate migration/contract authorization, current-version authority, transaction
and concurrency proofs, customer DTO/privacy review, runtime privilege review,
all API/UI/browser security gates and explicit deployment approval. A draft PR,
passing reference-model tests or merging these documents is none of those approvals.
