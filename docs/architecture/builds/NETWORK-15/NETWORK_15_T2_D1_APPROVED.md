# NETWORK-15-T2-D1 — final approved development ruling

Date: 2026-11-23. Baseline: `aa7c016b7a3cd4aca4769414b4f18242ea2cc7fe`.
Authority: Owner dispatch **ECHO GRID — NETWORK-15-T2 FINAL IMPLEMENTATION**,
section 3, “D1 OWNER RULING — APPROVED FOR THIS DISPATCH”.

**D1: Restore requires fresh, explicit, versioned customer consent.**

Binding requirements:

1. Initial Join requires affirmative consent.
2. Rejoin requires affirmative consent whenever reactivating a terminated membership.
3. Restore requires fresh affirmative consent; previously recorded consent cannot be silently reused.
4. Consent identifies the applicable policy/version and membership transition.
5. Membership transition and consent persistence commit atomically.
6. Failed transactions leave no partially restored membership or orphaned consent.
7. Historical consent remains auditable and immutable.
8. Concurrent retries/replays create no duplicate transitions, memberships or consent events.
9. Viewing, QR scanning, authentication and phone verification never constitute consent.
10. Business loyalty, customer registration and Community membership consent remain separate.

## Supersession and implementation

This final dispatch supersedes the earlier same-day development variant that
allowed platform Restore to reactivate with a matching prior grant. That variant
is historical, not the current contract; no already-recorded audit is rewritten.

The existing inactive state separates moderator clearance from customer consent:

- Authorized platform Restore clears suspended/suspended to inactive/closed,
  revokes prior active Community consent projections and appends an immutable
  non-consent clearance barrier. It never activates membership or releases awards.
- The authenticated customer sees unchecked current terms and an explicit Restore
  action. `POST /api/v1/community/me/join`, `operation:restore`, accepts only the
  current publication and clearance basis. Grant, immutable acceptance event and
  inactive-to-active activation commit atomically. Matching retries return that
  same new acceptance; previous consent or pre-clearance forms are insufficient.
- Voluntary left state, bans and renewed suspension cannot be overridden.
  Customer identity, phone, tenant and existing platform permissions are retained.
- Historical audit/ledgers, balances and membership/account IDs are preserved.
  No extra earning rule, financial service or authentication mechanism is added.

## Approval limits

Development, additive migration source/disposable databases, tests, real Chromium
and a draft PR are authorized. Legal wording/localizations, a legal version or
effective date, publication, live enrollment, shared migrations, deployment,
production configuration, merging and NETWORK-15-T3 are not approved here.
No approved effective publication is shipped; joining/restoring fails closed
without one. Customer UI translations are not approval of legal artifacts.
