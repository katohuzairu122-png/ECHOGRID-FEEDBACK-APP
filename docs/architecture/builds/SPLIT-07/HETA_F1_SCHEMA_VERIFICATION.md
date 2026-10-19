# HETA F1 — Non-activating schema verification

Baseline: `c17a6482737fc6606e28331bee67ef8a80e1fd85` (merged PR #140).

Migration 0045 adds six evidence tables and brings the migration journal to 46 entries. The manual isolated certification workflow previously asserted 45; its assertion now matches this reviewed baseline. Exact migration hashes remain checked by the existing production-migration verification script. This change does not run the manual workflow or access its Neon database.

`apps/api/scripts/verify-heta-evidence-schema.mjs` requires both an explicit disposable-database acknowledgement and a database URL. CI runs it after migration against its ephemeral PostgreSQL service; the manual certification workflow runs the same check after its existing endpoint and empty-database guards. Never run it against a persistent, staging or production database.

The verifier exercises actual PostgreSQL storage behavior with synthetic data:

- All six tables have enabled BEFORE ROW UPDATE/DELETE and BEFORE STATEMENT TRUNCATE triggers using the immutable-evidence function.
- Populated rows in all six tables reject UPDATE and DELETE. A combined TRUNCATE rejects through the immutable trigger, rather than a foreign-key error masking that denial.
- Missing provenance-attestation results, key-destruction evidence and coverage-gap cause reject at their named constraints.
- Duplicate encryption-key and provider-event identities reject; invalid key/attestation references, direct-account scope, mixed provenance, digest length and provider timestamp consistency reject.
- All five existing economic denial triggers remain installed and enabled.
- The fixture transaction rolls back, and all six fixture IDs are confirmed absent afterward. PostgreSQL identity sequences can advance despite rollback; this is one reason the database must be disposable.

## Local evidence and limits

On 2026-10-19, a fresh local PostgreSQL 16 Docker container applied all 46 migrations. The existing exact migration-hash verifier passed, the existing three-client advisory-lock/isolation/rollback verifier passed, and the new schema verifier passed 44 checks. No trigger was disabled, no economic row was inserted, and no Stripe request was made. The local container is disposable and is removed after verification.

The fixtures contain synthetic byte buffers and labels. They are not encrypted provider receipts or verified Stripe attestations. These tests do not establish cryptographic correctness, provider configuration, capture durability, authoritative tenant attribution, application RBAC/RLS, replay recovery, historical coverage, effective-time authority, or T01–T44 completion. They are not an independent architecture/security/economic approval.

## Next implementation prerequisite

PR #140 references HETA-01-F1 Revision 3.3 and owner decisions H1–H20, but that exact design and decision record are not versioned in this baseline. Record and reconcile them before implementing the remaining evidence module, retention/key custody, capture or projection wiring. HETA-01G's unresolved acceptance gates remain unresolved. Historical-tier verification, Partner Credit issuance and redemption remain denied. Split 06 ownership and migrations 0041/0042/0044 are unchanged.
