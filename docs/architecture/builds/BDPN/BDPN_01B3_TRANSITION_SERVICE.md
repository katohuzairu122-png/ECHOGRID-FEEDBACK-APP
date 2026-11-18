# BDPN-01B part 3 — profile transition service (implementation record)

**Status: IMPLEMENTED — VALIDATION PENDING (draft PR). Development only. Nothing calls this service yet: no route, no UI, no migration, no notification. It uses the storage tables from BDPN-F1 (merged, migration `0080`, not applied to staging or production) and the validator, digest and handle from BDPN-01B part 1 (PR #507, not yet merged; this branch contains it).**

- Implements `BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md` sections 3, 5, 7, 8 and 9 for the operations that need no new storage.
- File: `apps/api/src/business-profile/business-profile.service.ts`. Tests: `apps/api/test/integration/business-profile.service.integration.test.ts` (17 cases, real Postgres).

## 1. Operations

| Operation | Caller | Result |
| --- | --- | --- |
| `saveDraft` | Business (`profile:edit`, already authorized by the route) | Lazily creates the publication record (opaque handle, retried inside a savepoint on a collision), edits the open draft in place or opens revision n+1 |
| `submit` | Business (`profile:submit`) | Re-validates the stored content with the completeness rules (D-04) plus a business category, stores the canonical digest, freezes the revision |
| `withdraw` / `republish` | Business (`profile:submit`) | `published` to `withdrawn` (pointer kept); `withdrawn` to `published` only if the kept revision is still `approved` and the business is still eligible (D-13) |
| `approve` | Platform admin (`profile:moderate`) | Needs the digest the moderator saw: it must equal the stored digest AND one recomputed from the stored rows (threat T-04); reviewer is never the submitter; previous live revision becomes `superseded`; publication `published` |
| `reject` | Platform admin | Code-owned reason code (PENDING D-16), optional internal note (never audited) |
| `suspend` / `liftSuspension` | Platform admin | Suspension with evidence; lifting returns to `unpublished`, never auto-republished |

Every operation is one database transaction with row locks on the publication record and the revision, an optional optimistic `expectedVersion` (`PROFILE_VERSION_CONFLICT`), and one `audit_log` row per step written in the **same** transaction (a failed audit write rolls the operation back). Audit metadata holds the revision id, digest, reason code and actor role, and **never** profile text or the internal note. A guard or constraint refusal from the 0080 database triggers is reported as `PROFILE_STATE_CONFLICT`, so the rules hold twice (service and database).

Errors (design 5.4): `PROFILE_NOT_FOUND` 404 (also for another business's revision), `PROFILE_STATE_CONFLICT`, `PROFILE_VERSION_CONFLICT`, `PROFILE_DIGEST_MISMATCH`, `PROFILE_SELF_REVIEW_DENIED` 409, `PROFILE_VALIDATION_FAILED` 422 with `details: [{ field, rule }]` and no echo of rejected text.

## 2. Choices the design left open (please confirm)

1. **Approving while suspended is refused** (`PROFILE_STATE_CONFLICT`): the database forbids `suspended` to `published`, and the design does not say what an approval during suspension should do. After the suspension is lifted the profile is `unpublished`, and the next approved revision publishes it.
2. **Approving while withdrawn publishes** (design operation table: approve results in `published`).
3. **A rejection does not bump the publication version** (no state or pointer changes); every other operation does.
4. **`republish` eligibility** here is: business active, kept revision still approved, default-locale text present. The full discovery eligibility predicate belongs to the read model (BDPN-01C).
5. **The "reviewer holds a role in the reviewed business" rule (open question O-B2) is not enforced**; only reviewer-is-not-submitter is, in the service and in the database.

## 3. Not here (each needs its own authorization)

Idempotency keys (design 5.2: they need their own table and migration, so a later block), the moderator review bundle and queue reads (D-22), routes, notifications (open question O-B1), and the reason-code wording and policy (D-16).

## 4. Verification

API typecheck passes; the new files lint clean; the new integration test passes 17 of 17 (twice) against a local PostgreSQL 16 including a real two-connection concurrency race; the API unit suite passes. The reason-code list is a code-owned constant pending D-16. Hosted CI: see the PR.
