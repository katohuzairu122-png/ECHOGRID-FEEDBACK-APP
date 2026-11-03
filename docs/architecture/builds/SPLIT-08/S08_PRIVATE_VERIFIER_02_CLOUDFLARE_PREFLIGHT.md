# S08-PRIVATE-VERIFIER-02 Cloudflare preflight

Reviewed November 3, 2026 at main `2e622c41b357ae26b912a9f99bc3df01697fe93e`. PRs #198–#201 are merged. This record supplements the [verifier inventory](S08_PRIVATE_STRIPE_TEST_VERIFIER_INVENTORY.md) and [custody handoff](S08_PRIVATE_VERIFIER_02_PROVISIONING_CUSTODY.md).

| Finding | Classification | Evidence |
| --- | --- | --- |
| Cloudflare operator authentication | VERIFIED | Wrangler whoami succeeded with OAuth. It listed two account memberships and Workers permissions. |
| Approved Cloudflare account | BLOCKED | Two accessible accounts. The repository leaves owner selection pending and records deployment account only through a secret reference. Access alone cannot establish selection. |
| Repository contract | VERIFIED | Dedicated script name `echo-grid-s08-stripe-test-verifier`, `workers_dev=false`, inert 404 handler, no configured routes or triggers. |
| Actual Worker UUID, existence, versions, deployments and effective restrictions | PENDING | Requires authenticated inspection in the selected account. |
| Resource-only creation support | VERIFIED | Cloudflare documents creation of a standalone Worker resource before uploading a version. Availability in the selected account remains pending. [Create Worker](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/create/) · [Resource model](https://developers.cloudflare.com/changelog/post/2025-09-03-new-workers-api/) |
| Credential custody | PENDING | Future Worker-scoped encrypted binding `STRIPE_TEST_VERIFIER_RESTRICTED_KEY`. Verify the exact account, UUID and deployment implications before a separately authorized secret operation. |
| Stripe access | NOT APPLICABLE | This infrastructure block uses the owner-designated account as inventory metadata. |

## Resource-only execution plan

1. Record the owner-designated Cloudflare account ID and compare it to the authenticated membership. List Workers using GET /accounts/{account_id}/workers/workers and match the exact script name. A failed or incomplete list cannot prove absence.
2. For an existing match, record the immutable Worker UUID and account. Inspect versions, deployment associations, subdomain and preview settings, routes and domains, schedules, queues and inbound service bindings. Inspect binding names and types only. Compare authenticated API findings against the Dashboard or a second authenticated configuration query. Stop on collision or unexpected ingress.
3. For verified absence, use POST /accounts/{account_id}/workers/workers with the exact name and resource settings only. Keep code, versions and deployments outside this call. Verify the returned UUID with an independent GET and confirm zero versions/deployments and absence of invocation wiring. If resource-only creation is unavailable, retain the inert code deployment plan for separate authorization.
4. Record non-secret evidence references and the resulting scope. A Worker UUID establishes resource identity. An executable revision and its trust boundary require separate evidence.

No infrastructure mutation was performed during this preflight. GO for scoped inventory verification after account selection. Provisioning remains blocked pending the approved account.
