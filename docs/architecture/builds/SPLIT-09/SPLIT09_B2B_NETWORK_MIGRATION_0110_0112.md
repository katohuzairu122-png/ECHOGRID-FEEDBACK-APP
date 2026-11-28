# Split 09 B2B network migration notes (0110–0112)

These migrations are additive and have not been applied to staging or production.

## Migration contents

- **0110** adds partnership requests, lifecycle events, and partnerships. It adds unique pair/idempotency indexes and request expiry/cooldown access indexes. The 10-request cap is computed against each sender business's existing IANA `defaultTimezone`.
- **0111** adds in-app business notifications/read receipts, partnership messages/read receipts, non-binding collaboration proposals/events, abuse reports, and append-only moderation evidence. It adds lifecycle guards and `ENABLE ALWAYS` protections for immutable ledgers.
- **0112** adds participation withdrawal evidence and participation history. It extends the guarded participation state machine so withdrawal is terminal.

## Replay and upgrade requirements

- Generate/apply using the repository's Drizzle migration runner and journal; do not edit migration counts in scripts or workflows.
- Before any shared environment deployment, verify the migration prefix and schema compatibility through the existing release gates.
- The migrations require PostgreSQL and existing schema through 0109. Clean replay and upgrade testing from the current baseline must run in CI or an authorized disposable PostgreSQL database.
- The development environment used to prepare this change had no disposable PostgreSQL service or `DATABASE_URL`; no migration was applied locally.

## Recovery

These tables contain request, consent, message, proposal, notification, and moderation history. **Do not roll back by dropping the new tables or deleting rows.** If an upgrade fails before commit, use the migration runner's transaction rollback where supported, preserve the database, and capture the failing statement. If the migration commits but the application release must be reversed, deploy a compatible application revision that leaves the additive schema unused; repair with a new forward migration after diagnosis. Restore from a verified backup only under the existing database-recovery procedure. Never modify staging or production as part of this development branch.

Participation withdrawal is terminal, request and relationship events are append-only, and sent B2B messages/notifications are preserved. Corrections belong in a later additive migration and auditable forward-only repair.
