# S08 PR #181 review remediation — 2026-11-02

Development-only corrections for R181-01, R181-02 and R181-03. Not financial activation, provider authentication, an approved migration or production certification.

## Refreshed baseline

PR #181 merged on 2026-10-27 at `d04e918b7d884bef860810624c4f8a7d4ae51901`. Its old branch remains at `c0f4f2dae285288f7c6101093b06d1c566c74774`. Authoritative main at remediation start is `50048ab6f289fb3d3955892d6697638370a045b0` (PR #189 merged). All three reviewed gaps remain in that baseline. A separate corrective PR is required because #181 is closed; no merged history is rewritten.

## R181-01: shared lock and allocation binding

- Freeze locks its reservations in canonical UUID order before inspecting attempts or writing storage.
- `beginApply` first resolves intent identity without locking, locks its reservation, then locks the intent and rechecks the binding. It never holds the intent lock while waiting for the reservation. The reservation lock is held through attempt/transition persistence and transaction completion.
- Consequently an attempt cannot cross the freeze's absence check while the freeze holds that reservation. A previously committed attempt still causes the competing freeze to reject, even on replay.
- Candidate allocation tables are not part of migrations. Where **both are absent**, the existing inert saga remains usable for its existing non-authorizing component workflows, now with shared reservation locking. This is not a new provider-write path or financial permission.
- Where candidate storage is installed, every **new** attempt requires a complete valid parent/children snapshot and exact reservation, original invoice intent, business, invoice, currency, amount, units and benefit-policy binding. Missing freeze, partial schema or inconsistent evidence fails closed. Replaying an existing attempt preserves its identity and does not originate another operation.
- This does not authenticate a live invoice, adopt draft eligibility, select tax/settlement rules, or integrate a Stripe writer. Default saga and financial guards remain unchanged.

## R181-02: full relational envelope verification

`verifyStoredAllocationEvidence` supplements JSON/digest verification with parent business/invoice/currency/policy/digest/aggregate/count/false-authority checks and exact, ordered child membership, freeze/business keys, invoice intents, positive expected amounts and original provider keys. Every child matches the recomputed artifact, establishing aggregate conservation as well as count. The freeze writer and candidate-aware attempt gate use the same verifier.

With no independent source input, reconstruction checks internal persisted integrity only. Self-consistent evidence is still not provider authenticity or financial authorization; both authority flags remain false. The writer continues to compare against its supplied validated input as well. Database constraints independently enforce positive values, uniqueness and composite tenant references; JSON/header/child equality and aggregate conservation remain application-verified. Candidate DDL has not been promoted to a migration or production append path.

## R181-03: expiry acceptance point

For a freeze or a **new** saga attempt, the acceptance point is the final server `clock_timestamp()` comparison under the acquired reservation locks immediately before transaction completion. A failure rolls back the parent, children, attempt, intent transition and transition log as applicable. An early timestamp projected before a lock wait is insufficient. Reconciliation and replay of an existing attempt remain possible after expiry so an existing obligation is not erased.

This is the last transactional validation point, not a guarantee about the later physical WAL commit timestamp. No guarantee of validity throughout an external network operation or unknown provider outcome is introduced.

## Verification evidence

- Installed pinned pnpm 11.9.0 with frozen lockfile, without dependency or configuration changes.
- Docker Desktop failed to initialize its local inference socket. Instead, initialized a separate disposable PostgreSQL 16.15 cluster under `/tmp/echogrid-s08-remediation-20261102/data` in WSL, loopback port 55462. Verified its data directory before running migrations; did not use the existing port-5432 cluster, staging or Neon.
- Replayed 52 migrations and independently matched all 52 database migration hashes against SQL files. HETA verifier: 44 checks passed. All five required economic guards enabled afterwards, with no leftover per-suite scratch databases.
- Focused PostgreSQL: **21 passed, 0 failed, 0 skipped** (20 transactional cases plus one enabled-guard/DDL-rollback case). Includes real saga/freeze lock barriers in both orders, an attempt committing before a waiting replay, missing freeze, mismatched intent fields, persisted parent currency/amount tampering, child monetary tampering, cross-business substitution, expiry during lock wait, expiry after children are materialized, and attempt/transition rollback after expiry.
- Focused pure billing regression: **142 passed**, a subset of API units. Full local API unit report: **1,319 passed, 0 failed, 1 pending**, 1,320 discovered. Report the pending case separately; do not count it as passed.
- Shared/API source+test/web typechecks passed; migration drift passed; ESLint zero errors with 31 existing warnings. Final CI against the published corrective SHA is recorded in the PR rather than predicted here.

Positive fixtures use only the unique disposable scratch database, with candidate/saga mutation guards disabled there and synthetic parent fixtures constructed using transaction-local replication mode. They do not establish production role/RLS security, authorized award provenance or permission to disable deployed guards. Failed gates leave no new persisted allocation or attempt. The main test database retains all financial guards.

## Preserved boundaries and remaining review

No changes to migrations 0040–0051, Drizzle schema/journal, candidate SQL, configuration, packages/lockfile, provider adapters, economic policy, ledger/account writers, Split 06 consent, Split 07 accounting/dispute holds, or historical-tier authorization. No migration 0052 is introduced. No Stripe API calls, deployments, issuance, redemption, financial consumption, settlements or next development block. Production guards remain fail closed.

No independent approval is claimed. Exact-head CI and separate reviewer/owner approval remain required. This does not certify process-kill recovery, unknown commit acknowledgements, production roles/RLS, every cross-domain lock interaction, provider mutation races or distributed financial settlement. Stop at this corrective PR; do not merge or deploy automatically.
