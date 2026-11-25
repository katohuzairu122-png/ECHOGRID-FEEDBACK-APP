# Community pilot eligibility and the enrollment boundary (CF-READINESS-2)

Status: **IMPLEMENTED — VALIDATION PENDING on hosted CI.** Nothing is deployed, migrated or enabled. Pilot mode is off by default.

## 1. Activation boundary (as implemented)
A membership is activated only when **all** of these hold, in one database transaction:

1. The operation's own server gate is on (`COMMUNITY_MEMBERSHIP_JOIN_ENABLED` / `_REJOIN_ENABLED` / `_RESTORE_ENABLED`, exact string `"true"`).
2. **Pilot eligibility**, when pilot mode is required (new binding `COMMUNITY_MEMBERSHIP_PILOT_REQUIRED`).
3. Valid current-policy consent (explicit, unchecked, version/language/hash-bound, idempotent).
4. Valid customer lifecycle: active account, verified phone, not suspended/banned, **no pending deletion request, not an anonymized shell**.
5. The repository's opaque permit (issued only after gate 1) accompanies the write.
`NETWORK_FEED_ENABLED` is never read by any of this. Platform clearance (`suspended → inactive`) never activates and is not pilot-gated.

## 2. The six runtime names (exact)
`NETWORK_FEED_ENABLED` (Feed and moderation only) · `COMMUNITY_MEMBERSHIP_JOIN_ENABLED` · `COMMUNITY_MEMBERSHIP_REJOIN_ENABLED` · `COMMUNITY_MEMBERSHIP_RESTORE_ENABLED` · `COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED` · **`COMMUNITY_MEMBERSHIP_PILOT_REQUIRED`** (new). The earlier report said "five"; the new pilot binding makes six. None appears in any `wrangler*.toml` or workflow.

| `COMMUNITY_MEMBERSHIP_PILOT_REQUIRED` | Effect |
|---|---|
| absent, or exactly `false` | pilot mode off; eligibility is not consulted |
| exactly `true` | eligibility required for Join/Rejoin/Restore |
| any other value (`TRUE`, ` true`, empty, `yes`, `1`, …) | eligibility required (**fails closed to the stricter state**) |

## 3. Eligibility store and authority
- Table `community_pilot_eligibility_events` (migration 0090): append-only history (`seq`, customer, `grant`/`revoke`, staff actor, mandatory reason ≤ 500 chars, time). A customer is eligible only while the **latest** event is a grant. A database guard refuses UPDATE, DELETE and TRUNCATE even for the owner; the only permitted UPDATE is PostgreSQL's own `ON DELETE SET NULL` on the actor column.
- Changes only through `POST /api/v1/platform/community-pilot/:customerId/grant|revoke` (and `GET` for status): **platform admin role only**, new code-owned permission `community:pilot` (support and billing roles lack it; no database permission rows to provision). Each change appends one event and one `audit_log` row (`community.pilot_grant` / `community.pilot_revoke`) in the same transaction; repeating a change appends nothing.
- No customer self-service, no business-owner, manager or cashier path exists. Eligibility is global to the customer, so there is no tenant to cross.
- **Immediate revocation:** the activation check takes a shared per-customer advisory lock until its transaction ends; a revoke takes the exclusive lock. A revoke therefore waits for an in-flight activation and is always seen by the next one. Revocation stops future activations; it deletes no membership, consent evidence, points or audit data, and the customer can still Leave.
- The runtime role gets INSERT and SELECT only on the new table (manifest regenerated; verified as a restricted login: UPDATE/DELETE/TRUNCATE denied).

## 4. Customer deletion interplay (CUST-DEL-01/02)
`customer_deletion_requests` pending, or an anonymized shell, blocks Join/Rejoin/Restore at the **service** level with `409 COMMUNITY_ACCOUNT_DELETION_PENDING` (in addition to the shared customer middleware's `403 ACCOUNT_DELETION_PENDING`), and hides activation in the offer. Leave stays allowed. Cancelling the deletion request re-allows Community (with fresh consent). Nothing is erased or re-purposed by this change.

## 5. Emergency disablement
Unset (or set `false`) the operation gates to stop all new enrollment at once; or set `COMMUNITY_MEMBERSHIP_PILOT_REQUIRED=true` and revoke to narrow it. Neither deletes membership, consent or ledger data. (Any such change is an Owner action.)

## 6. Monitoring signals added
Bounded, identifier-free log events `community_membership.control` with reasons `pilot_not_eligible` and `deletion_pending` (once per isolate per operation/reason, by the existing design). Rates must come from Workers request logs (HTTP 403 `COMMUNITY_PILOT_NOT_ELIGIBLE`, 409 `COMMUNITY_ACCOUNT_DELETION_PENDING`).

## 7. Evidence (local, 2026-11-25)
- 21 integration tests on real PostgreSQL 16, passing both as the owner and as a restricted runtime login: pilot off/required/fail-closed values, eligibility never replaces other gates, Feed flag irrelevant, immediate revoke for Rejoin/Restore, idempotent audited events, append-only history, shared-lock race, deletion-pending blocks all three operations, Leave allowed, cancel re-allows.
- Mutation checks: removing the pilot check fails 9 tests; removing the deletion guard fails 3; removing the shared lock fails the race test.
- Real-Chromium four-locale rehearsal added (see the certificate for results).
