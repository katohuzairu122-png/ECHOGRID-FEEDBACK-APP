# Gate 2 B4-11 — Restricted nonowner broker database role (disposable proof)

**DEVELOPMENT / DISPOSABLE POSTGRESQL 18 ONLY. NOT A MIGRATION, NOT A DEPLOYABLE ROLE, NO RUNTIME AUTHORITY.** No Neon, Hyperdrive, Cloudflare, credential, staging, production, deployment or financial change. The broker service itself does not exist yet.

## Baseline
Authoritative main `8fd2159d078ca8da6444cba9a0669894642298f7`. The proof replays the 67 committed migrations and runs on the **real** tables (users, refresh_tokens, businesses, branches, user_business_roles, roles, role_permissions, permissions), not synthetic copies.

## Trust model (follows B4-07)
PostgreSQL cannot verify the B4-03 Ed25519 assertion (B4-06). The chosen route is: the isolated broker **service** verifies the B4-03/B4-09 evidence, then connects as a restricted login that only it holds. So the database trusts the **login** for "a verified request was made" and trusts **nothing else** the caller says: the routine re-derives authorization from persisted state at use time.

## The role and the one operation
\`scripts/sql/gate2-b4-11-restricted-broker-role.sql\` (applied only by the disposable script):
- Login \`gate2_b411_broker\`: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOINHERIT, no role memberships, role-level statement and idle-in-transaction timeouts. **No table, view, sequence or schema privilege anywhere**; USAGE only on its own schema; EXECUTE on exactly one routine.
- Routine \`gate2_b411.branch_read(actor, session, business, branch, nonce, expires_ms)\`: SECURITY DEFINER, fixed \`search_path = pg_catalog\`, \`lock_timeout = 3s\`, not executable by PUBLIC, owned by a NOLOGIN owner role, refuses any caller whose \`session_user\` is not the broker login (defense in depth beside the grant). Returns one row: \`outcome\`, \`branch_id\`, \`branch_name\` — nothing else.
- Routine owner \`gate2_b411_owner\` (NOLOGIN): table-wide SELECT and ONE column-level UPDATE on each of the eight locked tables, INSERT/DELETE on the nonce table only; no other write privilege on any application table.

## What the routine enforces (use time, in one transaction)
1. Arguments: all present; \`expires_ms\` in the future and within 120 s (otherwise it RAISES and consumes nothing, so a retry after a transient failure is possible).
2. **Single-use nonce, every outcome**: the nonce row is inserted first (\`ON CONFLICT DO NOTHING\`); a second use returns \`REPLAYED\`, even after a denial. Expired registry rows (older than 10 minutes) are removed by the routine itself, so the table stays bounded without a job.
3. Authorization chain, in the same fixed lock order as the issuer, each link locked \`FOR SHARE\`: actor active and not deleted → **exact session** live (not revoked, not expired, belongs to that actor) → business active → branch belongs to that business and is not deleted → permission chain: a non-deleted grant for that actor and business, **whose role belongs to the same business as the grant**, whose scope is business-wide or this branch, carrying \`branches:view\`.
4. Outcomes: \`OK\`, \`REPLAYED\`, \`DENIED_ACTOR\`, \`DENIED_SESSION\`, \`DENIED_BUSINESS\`, \`DENIED_BRANCH\`, \`DENIED_GRANT\`. The service must collapse everything except \`OK\` into one generic denial.

## Verified (110 checks, all passing; plus mutation testing)
- The login holds nothing (catalog scan of every table, view and sequence, all privilege types), cannot create anything, cannot \`SET ROLE\` / \`SET SESSION AUTHORIZATION\`, cannot run DDL, \`COPY\`, \`TRUNCATE\`, a DO block that reads tables, or read files; direct SELECT on application, financial, policy and evidence tables is refused; the nonce table cannot be read or forged; text arguments cannot carry SQL (uuid typing; no text overload).
- Every missing link denies: foreign business, foreign or deleted branch, branch of another business, no membership, role without the permission, branch-scoped grant used on another branch, deleted or suspended actor, unknown/other-actor/expired/revoked session, suspended business, deleted role, removed permission; restoring state authorizes again (nothing is cached).
- **Injected cross-tenant references (the R20 finding) grant nothing**: a business-A grant pointing at business B's role, and a business-A grant scoped to business B's branch, are both denied.
- Replay: the same nonce is refused after OK and after a denial; 8 concurrent connections on one nonce give exactly one winner.
- Races on the real tables: revoke-first (the broker waits on the row lock, then denies), issue-first (the revoker waits until the authorization commits, then the session is dead), grant revocation the same way; a held lock times out in 3 s and consumes nothing; a backend killed mid-call rolls its nonce back and the retry succeeds.
- Pooling: no state is kept between calls; a temporary table named \`users\`, a changed \`search_path\` and a custom setting do not change any outcome; application row counts are unchanged by reads.
- Static: the routine touches only the eight allowed tables plus its nonce table, and no financial, Stripe, policy or evidence relation.
- Mutation testing of the SQL: 25 of 26 mutants caught; the survivor (\`search_path\` swapped) is behaviourally equivalent because every object is schema-qualified, and is killed by the static definition check.

## Findings
1. **Two existing functions are callable by every login** (default PUBLIC EXECUTE): \`partner_credit_settlement_auth_digest\` (a pure digest) and \`pc_multiunit_month_lock\` (acquires a transaction-scoped advisory lock). Both are invoker-rights and touch no table, so they cannot read data, but any login, the broker included, can hold advisory locks. The proof pins this exact set; anything new that becomes callable fails the check. Remedy is a reviewed migration (a financial block): \`REVOKE EXECUTE ... FROM PUBLIC\`.
2. **Row locking needs UPDATE privilege.** \`SELECT ... FOR SHARE\` (what serializes use-time authorization against revocation) requires UPDATE on at least one column of each locked table. The owner role therefore holds one low-impact column UPDATE per table (verified required: revoking it makes the routine fail closed with a permission error). The broker login holds none.
3. R20's cross-tenant reference gap is real in the data model; the routine compensates by tenant-matching every link, but composite keys (R21) remain useful defense in depth.

## Limits and what this does not establish
- **The broker service does not exist.** Anyone holding the broker credential can call the routine with any actor and session identifiers. The database still requires a live session, active actor and business, and a permission-bearing tenant-matched grant, so the blast radius of a leaked credential is the branch id and name an authorized actor could already read; but without the service's signature check there is no proof a request came from that actor. Credential custody is therefore the control.
- Signature verification is NOT in the database. Hyperdrive compatibility (pooling, prepared statements, transaction mode) and a real isolated Worker are not exercised.
- This is a proof script, not a migration: nothing is installed in staging or production. Production still connects as the owner role with BYPASSRLS; no cutover is authorized.
- One operation only (branch read). Every further operation needs its own routine, tests and review.

## Next steps (not authorized)
Service-to-service identity and credential custody design; the isolated broker Worker; converting this SQL into a reviewed additive migration with its own non-superuser migration test; the PUBLIC EXECUTE hardening; staging smoke on an isolated fixture; signed release approval.

No merge, deployment, credential, Hyperdrive or financial activation. Financial activation remains NO-GO.
