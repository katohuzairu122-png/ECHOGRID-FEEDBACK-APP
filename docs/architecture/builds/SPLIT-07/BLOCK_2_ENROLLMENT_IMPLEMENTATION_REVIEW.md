# Split 07 Block 2 — Evidence hardening and Partner enrollment
**Scope:** No credit issuance, award decisions or ledger writes; migration 0041 barriers remain intact.
- Evidence verifier now executes unbounded indexed reversal-existence query rather than examining only 200 events.
- Internal enrollment service requires active platform administrator, active business, active consenting business user with business-wide `billing:manage` via current non-revoked role assignment, and active PC-ECON/1 exact frozen settings.
- Requires no previous enrollment; writes one business-level acceptance record atomically. No HTTP route, batch consumer, backfill or mint.
- This is NOT a cryptographic consent receipt; before exposing any enrollment command to clients, require a trusted authenticated business-user consent action/evidence record and platform audit record. A platform operator supplying an arbitrary user ID is not proof of that user's acceptance.
- Dedicated PostgreSQL tests cover non-admin and unrelated-consenter denial. Positive enrollment with actual terms acknowledgment and simultaneous enrollment race must be tested before runtime activation. Schema state and 0041 economic barriers remain unchanged.
- Next slice: revalidation semantics/negative evidence tests, verifiable acceptance protocol, and concurrency-aware provisional award design.
