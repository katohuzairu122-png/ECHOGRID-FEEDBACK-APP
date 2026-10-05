# Echo Grid project guide

Read `docs/ARCHITECTURE.md`, `docs/ERD.md` and `docs/API.md` before changing platform boundaries. Product decisions for branch purchase loyalty and the community are locked in `docs/LOYALTY_COMMUNITY_SPEC.md`; amend that specification explicitly when changing a decision. A document lock is not a deployment or branch protection setting.

- One global phone-verified customer identity; community choice and branch membership are separate. Never turn QR scanning into silent community consent.
- Branch membership activates on a staff-confirmed qualifying purchase. Scans alone do not award purchase units. Non-buyers' future survey points are distinct from branch balances.
- Customer JWTs and staff JWT/RBAC are separate trust domains. Mount customer routes before overlapping staff parent middleware, or use disjoint prefixes.
- Staff changes require business and branch scope plus the relevant permission. Customer reads/mutations must filter by authenticated customer identity.
- Keep routes thin, services framework-independent and database access inside the API. Transaction-owning loyalty services are the documented exception to repository-only service access.
- Use the append-only branch ledger as balance truth. Serialize mutations with membership locks. Preserve receipt/request idempotency and reward reservations. Fulfillment must not spend twice.
- Preserve existing business balances and ledger history. Never guess a branch, duplicate a business balance into every branch or relabel scans as purchases.
- Closed/canceled business rewards remain customer entitlements. Survey funding, partner settlement and subscription compensation are unresolved; do not invent conversion values or issue credits before their rules are approved and implemented.
- Customers do not pay a subscription. Both business onboarding modes use business subscriptions; final prices and branch limits are deferred.
- Browser mutations use Server Actions. Keep tokens in httpOnly cookies. Do not send secrets or OTPs into logs or fixtures.

Useful checks: `pnpm typecheck`, `pnpm --filter @echo-grid-feedback/api db:check`, `pnpm test`, `pnpm --filter @echo-grid-feedback/api build` and the web build command in its package scripts. Schema edits need generated SQL and snapshots. Database-dependent behavior needs a real PostgreSQL engine test, not a fake transaction callback. Production migrations are governed by `docs/DEPLOYMENT.md`; PR creation is not production migration or rollout.
