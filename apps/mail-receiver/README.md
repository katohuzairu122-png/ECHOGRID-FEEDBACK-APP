# @echo-grid-feedback/mail-receiver

CASHIER-AUTH-02E E2D: a **test-only** Cloudflare Email Worker that holds the confirmation email of a synthetic acceptance-run customer for one authenticated, single-use retrieval by the acceptance harness.

**Not deployed by any workflow. Not deployable as committed:** the recipient domain, sender domains and link hosts are empty, so the Worker refuses all mail and all retrieval until an owner-approved, separately authorized infrastructure block sets them. No secret, route or Email Routing rule is declared here.

Design, protocol, security analysis, secrets (names only), costs and the deployment/rotation/decommission procedures: `docs/architecture/builds/CASHIER/CASHIER_AUTH_02E_E2D_CLOUDFLARE_TEST_MAIL_RECEIVER.md`.

```bash
pnpm --filter @echo-grid-feedback/mail-receiver typecheck
pnpm --filter @echo-grid-feedback/mail-receiver test          # pure-logic unit tests (Node)
pnpm --filter @echo-grid-feedback/mail-receiver test:workers  # real workerd + Durable Objects, offline
pnpm --filter @echo-grid-feedback/mail-receiver build         # wrangler dry run, uploads nothing
```
