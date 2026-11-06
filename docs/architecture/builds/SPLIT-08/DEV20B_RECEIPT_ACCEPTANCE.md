# DEV-20.B receipt acceptance boundary

Development only. Migration 0066 remains additive and inert. No D4 or R10
writer, policy, route, production credential or financial activation is changed.

A runtime-issued custody receipt proves an earlier verified read. It is not a
permanent assertion that the signing key or workload remains trusted. The
recorder now captures a private canonical evidence snapshot before its first
await, verifies its hash against the issued receipt, locks the reservation,
loads persisted expectations, classifies and signs the authorization, then
revalidates custody before its replay lookup or inserts. Revalidation uses the
original issued reader, rechecking current workload authorization, stored
integrity, signature and active key state. It also compares the payload digest
and signing-key id/version to the receipt. Failure aborts the transaction.

The current key-directory verification in that final custody read is the
acceptance point. Runtime key configuration is not a PostgreSQL transactional
resource: this does not claim atomicity between subsequent external key
revocation and database commit. Historical links are never rewritten. A future
requirement for commit-serialized revocation needs a separately designed key
lifecycle transaction protocol; this block does not invent one.

The custody reader must use a separate database connection, or a pool with
capacity for its transaction while the recorder holds its reservation lock.
Do not compose both services over the same single checked-out client. Custody
read/verification audit events remain independently durable even if recorder
persistence rolls back; authorization and link rows alone commit atomically.

The synthetic PostgreSQL tests verify retained-receipt revocation, revocation
during signing, caller mutation during async digest work, concurrent identical
requests, link-insert rollback, signing failure, substitution, independently
isolated custody composite-FK failures and refusal to upgrade legacy evidence.
The non-superuser migration harness verifies 0066 ownership, forced RLS,
validated FKs, role privileges, immutable triggers and temporary-grant cleanup.
No synthetic result certifies real provider facts or grants consumption authority.
