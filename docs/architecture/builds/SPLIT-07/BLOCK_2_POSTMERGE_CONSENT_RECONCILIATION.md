# Split 07 Block 2 — Post-Merge Consent Reconciliation

**Status:** Corrective implementation review; economic issuance remains disabled.

## Reconciled implementation
- Restores separate Partner terms acceptance audit event and platform enrollment approval audit event.
- Enrollment requires a matching, recent, business-scoped, actor-scoped acceptance reference and matching frozen policy version.
- Keeps two distinct authorities: authenticated business-wide consenting user and active platform administrator.
- Restores negative PostgreSQL evidence test and award eligibility UTC-month tests, plus the concurrency preparation document.
- Does **not** remove 0041 PostgreSQL economic activation guards or create credit awards.

## Critical security gate: not yet an exposed consent workflow
The internal `recordAcceptance({ authenticatedUserId, ... })` method expects an already-authenticated user identity provided by server-side session middleware. **It does not authenticate the caller itself.** Never expose it through public routes or background jobs accepting a caller-supplied user ID. Before activation, implement a route that derives the principal from the validated session, rejects impersonated sessions, binds user-business scope, requires explicit acceptance of the exact rendered terms digest, and records request correlation and audit metadata. Perform the enrollment approval in a separately authorized platform-administrator context.

## Remaining acceptance tests
Positive acceptance-to-enrollment with real business-wide role fixture; expired/mismatched/cross-business/replayed acceptance; concurrent enrollment and role-revocation races; actual Split 06 fulfilled and reversed evidence; audit rollback; CI full integration and migration zero-drift. Completion of this reconciliation alone does not pass those gates.

## Implementation status
Block 1 completion lock preserved. Block 2 development proceeds behind 0041 inert triggers. No provisional award, vesting, redemption, subscription credit or Stripe mutation is allowed.
