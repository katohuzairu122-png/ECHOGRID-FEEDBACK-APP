# SPLIT 09 S9-A1: B2B participation foundation

Status: IMPLEMENTED, development only. Not merged, not deployed, migration 0081 not applied to any shared environment.

## Scope
Implements owner ruling S9-D1 (participation = platform enrollment + business acceptance of B2B terms) under S9-D12 / OD-24 (per-block migration). Storage, DB guards and a server-side service. No routes, no UI, no permissions seeded, no notifications.

## Components
- Tables (migration `0081_b2b_participation_foundation`): `b2b_terms_versions` (ships EMPTY), `b2b_participations` (one row per business).
- Service `apps/api/src/b2b/b2b-participation.service.ts`: `recordAcceptance`, `enroll`, `suspend`, `reinstate`, `findForBusiness`, `isParticipating`.
- DB guards: terms immutable and `draft -> active -> retired` only; participation fields immutable, `active <-> suspended` only, no delete/truncate (ENABLE ALWAYS), insert requires the ACTIVE terms version and matching digest, acceptor differs from the enrolling admin, at most one row per business.

## Fail-closed behaviour
No B2B terms text is owner-approved, so no terms version exists. Acceptance and enrollment return `B2B_TERMS_NOT_ACTIVE` until a separately authorized step activates an approved version. `isParticipating` is the eligibility term later blocks must use (active record on an active business).

## Assumptions needing owner ruling (not invented as policy)
1. INTERIM acceptance authority: business-wide `billing:manage` (same as Split 07 terms). Spec s7 keys (`b2b:manage` etc.) are unratified; none was created.
2. Terms text, version label and activation procedure (who inserts/activates a version).
3. Acceptance receipt freshness of 24h is copied from Split 07, not from the B2B spec.
4. Suspension requires a free-text reason (1 to 500 chars) stored in audit only; moderation roles/reason codes (S9-D10) remain open.
5. No `left`/termination state: S9-D6 (termination and retention) is open.

## Not implemented (blocked by open decisions)
Partnership requests (S9-D3, D4), grants (D5), termination (D6), messaging (D7), notifications (D9), moderation roles (D10), plan gating (D11), directory/UI, B2B capability sections on the BDPN profile.

## Economic isolation
No loyalty, points, Community, Partner Credit, billing or customer rows are read or written (asserted in the integration test).

## Changelog
- 2026-11-18: S9-A1 created.
