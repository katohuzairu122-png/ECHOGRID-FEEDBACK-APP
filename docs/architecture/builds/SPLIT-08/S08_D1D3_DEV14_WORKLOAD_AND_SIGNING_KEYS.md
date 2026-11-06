# S08 D1/D3-DEV-14 — Secure Workload and Signing-Key Configuration Foundations

Status: DEVELOPMENT ONLY. Inert. Financial activation: NO-GO. **No migration, no table**: signing workloads and key directories are trusted runtime configuration and private keys never touch the database. `approval_enabled` stays false and no DEV-14 module can reach it (static and database tests).

Baseline: DEV-11 already provides the read-workload identity (`workload-identity.ts`) and Ed25519 observation signing custody (`signing-custody.ts`). DEV-14 adds the generic layer on top without changing them.

| Module | Purpose |
|---|---|
| `evidence-signing-keys.ts` | Key record contract: id, version, algorithm allowlist (Ed25519), purpose, environment, lifecycle state PENDING / ACTIVE / RETIRED / REVOKED, issuance window, retention deadline. Strict parser: any inconsistent, duplicate, extra or production-synthetic record makes the whole directory untrusted. Explicit verification policy (default REJECT for retired keys; revoked keys never verify). Disabled production adapters (directory rejects, signer provider holds no key). |
| `evidence-signing-workload.ts` | `SigningWorkloadIdentity` (distinct from the DEV-11 read identity): from trusted configuration only, no identity parameter, reloaded per check; bound to environment, purposes and an explicit business allowlist (no wildcard); expiry and revocation take effect on the next request. Disabled production source. |
| `evidence-signing.ts` | Signing boundary (`sign` takes only businessId, purpose, evidenceType, payload; strict request) and strict verifier. Deterministic, domain-separated, length-prefixed signed message bound to schema/version, evidence type, purpose, environment, business, workload, key id/version, algorithm, signing time and payload SHA-256. Payloads carrying a verdict (eligible/approved/...) are refused. A successful verification returns `authenticity: AUTHENTIC` and the constant `financialAuthorization: NOT_GRANTED`. |
| `evidence-signing-test-support.ts` | TEST-ONLY synthetic keys and identity source; not exported from the index; refuses to build for production. |

Verification order: structure, schema, expected bindings, key id, version, algorithm, key purpose and environment, lifecycle (revoked: never; pending: never; retired or past issuance: only under the explicit policy and before the retention deadline), signing time inside the key window, payload hash, signature.

## Known limits / owner decisions
1. No production signing workload, key directory or key custody exists; the production adapters are disabled by design.
2. The retired-key verification policy defaults to REJECT until the owner approves `ACCEPT_WITHIN_RETENTION`.
3. Signing/verifying creates no persistent record; durable storage of signed evidence is outside this block.
4. The DEV-13 activation contract is untouched and still has no designated authority.
