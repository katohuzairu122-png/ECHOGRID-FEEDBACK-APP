# S08-PRIVATE-VERIFIER-02 Cloudflare preflight

Reviewed November 3, 2026 at main `2e622c41b357ae26b912a9f99bc3df01697fe93e`. PRs #198–#201 are merged. This record supplements the [verifier inventory](S08_PRIVATE_STRIPE_TEST_VERIFIER_INVENTORY.md) and [custody handoff](S08_PRIVATE_VERIFIER_02_PROVISIONING_CUSTODY.md).

| Finding | Classification | Evidence |
| --- | --- | --- |
| Cloudflare operator authentication | VERIFIED | Wrangler whoami succeeded with OAuth. It listed two account memberships and Workers permissions. |
| Approved Cloudflare account | OWNER-DESIGNATED (verification pending) | Owner explicitly designated INFINICUS LLC, account `b0ca727d821092e2e14720223ac07edb`, on 2026-11-03. Previously observed in authenticated Wrangler account membership; re-verify actual membership before API requests. Personal account `cf205213947e3617297373060fe4c15f` excluded. |
| Repository contract | VERIFIED | Dedicated script name `echo-grid-s08-stripe-test-verifier`, `workers_dev=false`, inert 404 handler, no configured routes or triggers. |
| Actual Worker UUID, existence, versions, deployments and effective restrictions | PENDING | Requires authenticated inspection in the selected account. |
| Resource-only creation support | VERIFIED | Cloudflare documents creation of a standalone Worker resource before uploading a version. Availability in the selected account remains pending. [Create Worker](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/create/) · [Resource model](https://developers.cloudflare.com/changelog/post/2025-09-03-new-workers-api/) |
| Credential custody | PENDING | Future Worker-scoped encrypted binding `STRIPE_TEST_VERIFIER_RESTRICTED_KEY`. Verify the exact account, UUID and deployment implications before a separately authorized secret operation. |
| Stripe access | NOT APPLICABLE | This infrastructure block uses the owner-designated account as inventory metadata. |


> **Ownership boundary correction (2026-11-03):** ECHO GRID has **not** been transferred to INFINICUS LLC. The owner's earlier approval identified the INFINICUS LLC Cloudflare account as a *proposed verifier hosting destination*, not a transfer of project ownership, repositories, billing, credentials, or financial responsibility. Until a separately documented cross-entity hosting arrangement and access/custody authorization is approved, **do not create the Worker, deploy code, attach bindings, or provision credentials in the INFINICUS LLC account**. Read-only inspection of the selected account remains the only authorized infrastructure action.

**Owner operating model (2026-11-03):** ECHO GRID remains independently operated and uses INFINICUS LLC as an infrastructure hosting provider. This is **not an ownership transfer**. See [S08-PV02-HOSTING-01](S08_PRIVATE_VERIFIER_02_HOSTING_OPERATING_MODEL.md) for distinct operational, infrastructure, credential and provisioning authority boundaries. The hosting decision does not itself authorize Worker creation, code deployment or secret issuance.

## Owner account designation — 2026-11-03

The owner approved **INFINICUS LLC**, Cloudflare account ID `b0ca727d821092e2e14720223ac07edb`, as the proposed hosting account for the ECHO GRID S08 private verifier, without transferring ECHO GRID ownership. The personal Cloudflare account `cf205213947e3617297373060fe4c15f` must not be used for this workload. This authorization permits **read-only Worker inventory inspection** in the designated account, not an implicit deployment or credential operation. Resource-only creation remains conditional on independently verified absence, correct permissions and a supported creation path; do not deploy executable code, attach routes/triggers, or install Stripe secrets. The Worker UUID and effective settings are **not yet verified**.

## Resource-only execution plan

1. Record the owner-designated Cloudflare account ID and compare it to the authenticated membership. List Workers using GET /accounts/{account_id}/workers/workers and match the exact script name. A failed or incomplete list cannot prove absence.
2. For an existing match, record the immutable Worker UUID and account. Inspect versions, deployment associations, subdomain and preview settings, routes and domains, schedules, queues and inbound service bindings. Inspect binding names and types only. Compare authenticated API findings against the Dashboard or a second authenticated configuration query. Stop on collision or unexpected ingress.
3. For verified absence, use POST /accounts/{account_id}/workers/workers with the exact name and resource settings only. Keep code, versions and deployments outside this call. Verify the returned UUID with an independent GET and confirm zero versions/deployments and absence of invocation wiring. If resource-only creation is unavailable, retain the inert code deployment plan for separate authorization.
4. Record non-secret evidence references and the resulting scope. A Worker UUID establishes resource identity. An executable revision and its trust boundary require separate evidence.

No infrastructure mutation was performed during this preflight. GO for scoped inventory verification in the owner-designated account. Resource creation remains blocked pending a separately approved cross-entity hosting and credential custody arrangement, in addition to authenticated absence verification and supported resource-only creation; **no provisioning has yet been performed**.
