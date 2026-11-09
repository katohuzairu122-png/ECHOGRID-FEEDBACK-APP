# Gate 2 B4-02 — Disposable Restricted Branch Read Broker

**Date:** 2026-11-09. **Scope:** development-only PostgreSQL 18 disposable test, independent of B4-01 PR #323. **No merge, live Neon SQL, database role/credential changes, Cloudflare/Hyperdrive edits, application deployment, financial activation or original staging migration.**

## Baseline and target

- Independent starting `main` `19c489ef1db977abc10fa5186ac183c135bcc816`. B4-01 #323 exists as a separate draft, and was not incorporated into this branch.
- Target operation is a single scoped nonfinancial branch read: `gate2_b4_02.read_one_branch(...)`. This is an isolated **fixture** broker; B4-01 declares a **future** `gate2_b4.read_one_branch` interface, not yet applied to a real database.
- Test requires `GITHUB_ACTIONS=true`, an explicit disposable marker, the exact `localhost` PostgreSQL 18 URL/database `echogrid_ci_pg18_b4_02_broker`, and replay of 67 committed migrations.
- Test fixture issues a fresh random HMAC test key; the fixture database holds its verifier copy. This does not prove a trusted external issuer, production HSM/KMS custody, constant-time production signature verification or real JWT/session integration.

## Restricted DB proof

A CI-only restricted LOGIN with `NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION` has only schema USAGE and EXECUTE of a fixed `SECURITY DEFINER` SQL function. The function pins `search_path=pg_catalog,gate2_b4_02` and checks the signed test assertion's issuer, audience, key ID, actor, exact session, business, branch, operation `branches:read`, request, nonce, and bounded TTL. It verifies stored active session and business/branch membership under row locks, then atomically consumes the nonce before returning a **single tenant- and branch-constrained** synthetic row: `branch_id,business_id,branch_name,branch_slug,branch_status`.

The disposable test asserts:
- Correct business A and B scoped outputs, including business ID.
- Signed-field mutation, unknown issuer/key, stale session, wrong tenant, GUC spoof, expired/overlong assertion and disabled verifier key denial.
- Soft-deleted branches are never emitted.
- Direct SELECT on real public businesses, branches, customers, and on synthetic key/session/branch tables is denied to restricted LOGIN.
- Concurrent same-nonce requests yield exactly one authorized success; rollback allows a fresh attempt, followed by committed-replay denial.
- Revocation acquiring the session row first blocks an in-flight authorization until it can deny; authorized operation locking first commits before revocation, with all subsequent attempts denied.

## Limits and next security gates

- **This proves disposable SQL privilege and isolation mechanics only.** The signing authority and fixture session/membership state are controlled by test code. There is no independent real actor/session or permission authorization. The SQL function is intentionally not installed on staging/production, nor exposed through an API or a Hyperdrive binding.
- No live branch business query, real schema-wide RLS policy, realistic PII/financial access, Cloudflare pool behavior or production credential rotation is tested. Neither B4-01 nor B4-02 can justify switching `HYPERDRIVE` away from existing runtime credentials without coordinated repository changes and security release approval.
- B4-03 must design and verify the trusted issuer and real actor/session/tenant/permission bridge, not permit mutable request headers or GUC to assert authority. B4-04 must safely integrate a nonfinancial route OFF by default and prove current API behavior is preserved.
- Existing staging and production original branches remain at 45/67 migrations; the staging isolated recovery branch passed the 67/67 rehearsal. All live work remains separately authorized.

**Verdict:** require dedicated exact-head CI, full CI and independent review before this disposable-only block can be called development-verified or merged.
