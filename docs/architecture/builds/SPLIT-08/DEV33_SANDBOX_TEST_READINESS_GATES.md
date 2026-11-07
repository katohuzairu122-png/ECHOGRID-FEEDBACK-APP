# DEV-33 — Controlled Sandbox Test Readiness Gates

**Status:** development-only readiness contract. No deployment, live credentials, production migrations, financial execution, or implicit authorization.

## Purpose
Transition from isolated synthetic observation regression (DEV-25–32) to a **separately authorized, isolated staging or local end-to-end test** of the existing Echo Grid architecture. The DEV-26–32 observation correlation harness remains disposable, test-only and **is not** durable billing evidence, settlement proof, idempotency or financial authority.

## Evidence-based baseline
- GitHub Actions CI has validated code at the recent DEV-32 head. This does **not** prove live runtime readiness.
- `docs/SETUP.md` describes Neon PostgreSQL, Cloudflare Hyperdrive, R2, KV, Queues, JWT secrets, optional external providers and Stripe test credentials.
- `docs/DEPLOYMENT.md` describes a separate manual staging migration and production release path. Its historical statement that nothing was deployed is **not current evidence**; verify actual resources.
- The monorepo has existing block13–block18 verification scripts; do not replace them with this checklist.

## Go/no-go checklist — require recorded evidence for each

| Gate | Evidence | Failure action |
| --- | --- | --- |
| G1 Reviewed baseline | DEV-32 merged, DEV-33 reviewed/merged, exact main SHA recorded, CI green at that SHA | Stop |
| G2 Isolation | Separate Neon staging database, Cloudflare resource IDs, secrets and test accounts; production inaccessible to test credentials | Stop |
| G3 Configuration | Node >=22, pinned pnpm 11.9.0; API and web env contract validated; allowed origins, API base URL, three distinct JWT secrets | Stop |
| G4 Schema | Reviewed migration ledger/hash check; explicit authorization before staging migration; permission and plan seeds on staging only | Stop |
| G5 Infrastructure | Staging Hyperdrive, KV, R2, Queue, DLQ, rate limiting, health and auth verified with no production bindings | Stop |
| G6 Billing containment | Stripe **test mode** only; endpoint signature validation, test price IDs, webhook replay and no real payment methods | Skip billing tests until satisfied |
| G7 Security | Business/branch tenant isolation, RBAC, OTP limits, signed QR, duplicate/replay controls, rollback, audit evidence | Stop for affected flow |
| G8 Observability | Request IDs, sanitized logs, error and retry visibility, test artifact storage and rollback procedure | Stop |
| G9 Test approval | Owner explicitly authorizes local/staging runtime test scope, environment, data and allowed external calls | Stop |

## First test sequence
1. Run local `pnpm install`, `pnpm typecheck`, `pnpm test`, and existing block verification tools as appropriate, from reviewed main.
2. Prove staging resource isolation, then apply only approved staging migrations and seeds.
3. Start API and web in **local development** against staging/test resources; verify `GET /health`.
4. Create two synthetic businesses and separate staff/customer accounts; verify tenant isolation and access denials.
5. Test business onboarding → branch/QR issuance → feedback submission → verified loyalty award → eligible redemption; capture request IDs and ledger deltas.
6. Exercise negative scenarios: QR expiry/tamper, missing purchase, replay, cooldown, concurrent claims, wrong tenant, revocation and rollback.
7. Only after G6: Stripe sandbox checkout → signed webhook → duplicate delivery → subscription reconciliation; separately validate billing credits and revoked-award D4 controls without claiming settlement from synthetic observations.
8. Capture pass/fail, exact SHA, environment identifiers (nonsecret), sanitized logs, DB assertions, rollback evidence. Fail closed on any missing evidence.

## Owner handoff
**Next action is TEST-READINESS-01**, a read-only environment and integration inventory against the actual Neon/Cloudflare/Stripe **test** accounts. No production deployment or migration is authorized by DEV-33. Staging setup and test execution require explicit separate authorization. Do not mark operationally ready based on this document or green CI alone.
