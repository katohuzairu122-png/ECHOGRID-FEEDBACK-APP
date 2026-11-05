# S08 D1/D3-DEV-04 — Settlement evidence authenticity and database authority (development record)

Status: DEVELOPMENT ONLY, INERT. Financial activation: NO-GO. Synthetic evidence and synthetic keys only. Migration 0061 (depends on 0060 / PR #223, merged).

## Problem closed
DEV-03 stored an unkeyed SHA-256 digest with each settlement authorization. Anyone able to INSERT could compute a matching digest, so a database writer could manufacture an ELIGIBLE record the classifier never produced.

## Mechanism
1. **Provenance (Ed25519).** The trusted recorder signs `len:value;` over `[ECHO-GRID:S08-SETTLEMENT-AUTH-SIG/1, signing_key_id, evidence_digest]` (the digest commits to every field). The private key lives only in the recorder's credential (non-extractable CryptoKey); the database stores key id and signature only. The gate holds PUBLIC keys only (`trustedSigningKeys`, keyId -> 64-hex raw key; removing an entry revokes it). A principal with INSERT, UPDATE, BYPASSRLS or superuser can write any bytes and cannot make a signature verify.
2. **Roles (NOLOGIN groups, migration 0061):** `settlement_recorder` (INSERT only, through the RLS INSERT policy), `settlement_consumer` (EXECUTE on the verification function only), `settlement_authority_reader` (internal definer owner), `settlement_tenant_reader` (read, RLS-scoped by `echogrid.tenant_id`), `settlement_auditor` (read-only). Nobody has UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER. PUBLIC has nothing.
3. **RLS on the new table only:** ENABLE + FORCE. Policies: recorder INSERT, authority-reader SELECT, auditor SELECT, tenant-reader SELECT (tenant setting). The owner has no policy, so a non-superuser owner sees and inserts nothing.
4. **Verification read:** `partner_credit_settlement_auth_read(business, reservation, snapshot?)`, SECURITY DEFINER (owner `settlement_authority_reader`, pinned search_path, EXECUTE revoked from PUBLIC). The service never selects from the table. A session that may not call it fails closed (`AUTHORITY_UNAVAILABLE`).
5. **Recorder:** requires a signer and a valid role name (else `RECORDER_UNCONFIGURED`), runs the classifier, signs, then performs only the INSERT as `settlement_recorder` (else `RECORDER_ROLE_UNAVAILABLE`). Look-then-insert under the reservation lock (ON CONFLICT would demand a SELECT policy for the recorder).
6. **Gate order (inside the D4 transaction):** config, row, digest, provenance version, trusted key, signature, THEN verdict, binding, scope, policy, kind, interval, freeze, freshness. Replays return before the gate.
7. Binding trigger and ledger-gate trigger are now SECURITY DEFINER so they work under forced RLS. The ledger trigger additionally requires a signature to be present (structural only: SQL cannot verify Ed25519).

## Honest limits
- A database owner or superuser can still `ALTER ... DISABLE ROW LEVEL SECURITY` or disable triggers; the signature is what stops them from producing an accepted record. They could still insert unsigned INELIGIBLE rows (denial of consumption, not a grant).
- Anyone holding the recorder's private key can create valid evidence; custody, rotation and a production signing service are NOT built (no secrets invented).
- The tenant setting is a READ scope only; any session can set it. Writes are decided by role and signature, never by it.
- The consumption path reads through the definer function; production connection roles, memberships (e.g. app login in `settlement_consumer`) and key provisioning are owner decisions and untested outside synthetic roles. Running migration 0061 needs a role that can CREATE ROLE and ALTER FUNCTION OWNER (tested as superuser only).
- Evidence remains MOCK_SYNTHETIC. Q1/Q2, Q3, Q12, Q14, refund recovery and R10 are untouched.
