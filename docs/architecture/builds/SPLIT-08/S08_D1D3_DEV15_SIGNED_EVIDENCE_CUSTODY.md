# S08 D1/D3-DEV-15 — Durable Signed-Evidence Storage and Trusted Workload Integration

Status: DEVELOPMENT ONLY. Inert. Financial activation: NO-GO. **One additive migration (0065).** No Stripe contact, no production keys or workloads. `approval_enabled` is neither read nor written by anything here; custody success is authenticity only (`financialAuthorization: NOT_GRANTED`).

## Storage (`signed_evidence_records`, `signed_evidence_events`)
- A record is the EXACT DEV-14 signed representation: claims as columns, the canonical payload text that was hashed (the database re-hashes it and refuses a mismatch), the signature (unique), the custodian workload, and server-assigned facts (`created_at_ms`, `persisted_by_db_role`, `version = 1`, `content_digest`) that the BEFORE INSERT guard overwrites. Records are immutable: UPDATE / DELETE / TRUNCATE are denied to every role, including the owner (triggers fire ALWAYS).
- Events are append-only facts: `EVIDENCE_PERSISTED`, `EVIDENCE_REPLAYED`, `EVIDENCE_CONFLICT_REJECTED`, `VERIFICATION_ATTEMPTED`, `VERIFICATION_SUCCEEDED`, `VERIFICATION_FAILED`, `KEY_UNAVAILABLE`, `KEY_REVOKED`, `ACCESS_DENIED`. Actor database role, time and digest are server-side; an event must name the tenant that owns its record. Identical events by the same actor within 60 s are not repeated (bounded volume).
- The PERSISTED event is written by an AFTER INSERT trigger, so a failing audit insert rolls the record back.

## Database authority (FORCE RLS on both tables; fixed `search_path`; nothing executable by PUBLIC)
| Role (NOLOGIN) | Authority |
|---|---|
| `signed_evidence_lifecycle` | owns the SECURITY DEFINER functions; the only table writer (RLS policies) |
| `signed_evidence_writer` | EXECUTE `evidence_custody_persist` only |
| `signed_evidence_reader` | EXECUTE `evidence_custody_fetch`, `evidence_custody_record_verification` only |
| `signed_evidence_auditor` | SELECT on both tables |
Tenant isolation never depends on a session variable: `fetch` takes the tenant explicitly and returns nothing for a foreign or missing record (a foreign attempt leaves a bounded `ACCESS_DENIED` event naming only the claimant). `persist` is idempotent: identical content replays, anything else (same id with other content, or the same signature under another id) returns `CONFLICT` and replaces nothing; concurrency is resolved by the unique constraints with `ON CONFLICT DO NOTHING`.

## Service (`signed-evidence-custody.ts`, internal; no route)
`persist`: trusted custodian workload (role `EVIDENCE_CUSTODIAN`, the DEV-14 mechanism with a disjoint role) → DEV-14 verifier on the whole envelope before storage → verdict-free payload check → database function. `retrieve`: custodian check → tenant-bound fetch → recompute stored digest → RE-VERIFY signature against the current key directory and policy → record the outcome (if it cannot be recorded, nothing is returned). A database digest or RLS policy is never treated as proof of authenticity.

## Limits / owner decisions
1. Authority denials (unknown, expired, revoked, wrong-role or wrong-tenant workloads) never reach the database, so they cannot leave a custody event; they go to a bounded security-log channel with fixed fields. Writing them to the store would let an unauthorized caller write to it.
2. The table owner / superuser can still disable triggers or insert rows; such rows are detected on retrieval (digest mismatch or invalid signature), not prevented.
3. Provisioning logins into the three roles, real custodian workloads and real keys are owner decisions; nothing here provisions them.
