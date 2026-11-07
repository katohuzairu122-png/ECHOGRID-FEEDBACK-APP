# DEV-42 — Runtime Authorization Architecture Review and Contract Prototype

## Purpose
DEV-34–41 provide offline checks, self-reported evidence and denial examples. **None is integrated with actual API handlers, CI deployments, database migration runners, Cloudflare Workers, Neon, or Stripe.** DEV-42 defines a deliberately fail-closed, pure prototype to prevent accidental interpretation of those artifacts as executable authorization.

## Proposed architecture for future approval
1. Inventory actual side-effect entry points: migration CLI/CI workflows, staging deployment, service configuration, provider calls and financial write handlers. Review actual code and deployment policies before proposing patches.
2. Define an action-scoped owner authorization record, exact repository SHA, environment identifier, expiry, approving identity and single-use operation identifier. Do not accept offline report text as authority.
3. Verify authorization server-side against an authenticated trusted source, not caller-supplied JSON or frontend state. Separate staging from production authority.
4. Require independently verified isolation, secret provenance and operator-reviewed evidence. Use deny-by-default and an audit trail.
5. Preserve all existing tenant/RLS, idempotency, ledger, Stripe and D4/R10 financial safeguards. Never let a generic staging approval bypass financial gates.
6. Test missing, expired, replayed, cross-environment and wrong-SHA authorization. No real execution until independently reviewed and expressly authorized.

## Current implementation boundary
`tools/dev42-runtime-authorization-contract.mjs` is a **prototype only**. It always returns DENY. It is not runtime middleware and does not intercept or authorize any real side effect. Run `node --test tools/dev42-runtime-authorization-contract.test.mjs`.

## Hold
No migrations, staging integration, deployment, financial operations, or production access. Tuesday 2026-11-10 is a planning target, not authorization. DEV-42 is stacked on DEV-41 PR #265; retarget after upstream merges and require exact-head CI plus independent review.
