# DEV-70 — Customer Consent Revocation Outcome Accuracy

**Authorization:** Development-only; consent grant state responses only. No release, schema migration, financial/settlement or provider operations.

## Evidence-based gap
`POST /consent/:id/revoke` returned `{ revoked: true }` regardless of whether the repository changed a row. `ConsentGrantRepository.revoke` previously returned void even when the grant did not exist, belonged to another customer or was already revoked. This could misinform customers about their consent status.

## Scoped implementation
- Repository uses a customer-owned, active, unexpired grant predicate and `UPDATE ... RETURNING` to produce a Boolean indicating whether an effective active grant actually transitioned.
- Route returns `{ revoked: true }` only on a confirmed update; a missing, foreign, expired or already revoked grant yields the same HTTP 404 `CONSENT_GRANT_NOT_ACTIVE` with no cross-customer disclosure.
- Unexpected database errors still propagate rather than being represented as successful revocation.
- Direct route regressions use a stubbed authenticated customer; disposable PostgreSQL integration verifies true/false and expiry behavior against real SQL.

## Boundaries
Consent revocation still uses the existing repository's transactional SQL update; no new consent authority, RLS change, payment behavior, migration or external call. The change intentionally makes previously false-positive responses fail closed. Explicit revocation of an already-expired grant is not claimed as a new successful transition.

## Verification
Hosted exact-head unit, integration, typecheck, security, build and browser CI required, followed by owner review.
