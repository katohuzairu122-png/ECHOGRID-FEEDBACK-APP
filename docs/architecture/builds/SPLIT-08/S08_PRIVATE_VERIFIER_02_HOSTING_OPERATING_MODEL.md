# S08 Private Verifier — Independent Operation / INFINICUS LLC Infrastructure Hosting

**Owner decision date:** 2026-11-03  
**Decision ID:** S08-PV02-HOSTING-01  
**Decision:** ECHO GRID **remains independently operated**, and may use **INFINICUS LLC infrastructure** as a hosting provider. This decision is not an asset, company, intellectual-property, repository, customer, billing, Stripe account or ECHO GRID ownership transfer.

## Scope and separation of authority

| Domain | Decision / responsible control |
| --- | --- |
| ECHO GRID project operation and product/business decisions | Remain with the existing ECHO GRID operator; no transfer is represented |
| Cloudflare hosting infrastructure | INFINICUS LLC Cloudflare account `b0ca727d821092e2e14720223ac07edb` is the **owner-selected host** for the proposed isolated test verifier |
| Personal Cloudflare account | `cf205213947e3617297373060fe4c15f` is excluded for this workload |
| Proposed dedicated Worker | `echo-grid-s08-stripe-test-verifier`; actual Worker presence, identity, effective ingress, deployed revision and runtime attestation **NOT YET VERIFIED** |
| Stripe test account | Owner selected test account `acct_1TtKaUQ0xjd6eYbP` (Infinicus simulation engine); cross-project test access is **not** an ownership or credential-custody transfer |
| Stripe restricted credential | New, minimum-scope **test-only** credential must be separately authorized; inventory reference/version and secret custody remain PENDING |
| Customer/financial data and billing | No transfer or activation authorized; preserve existing ECHO GRID business permissions, tenant isolation, guarded financial tables and Stripe write restrictions |

## Required hosting-and-custody authorization boundary

Owner selection of the hosting account permits **read-only Cloudflare inventory inspection** in that account. Before creating a resource or deploying the Worker, the owner and authorized INFINICUS LLC infrastructure administrator must approve and record:

1. **Hosting mandate and scope:** ECHO GRID remains independently operated; INFINICUS LLC acts as the infrastructure host for this exact isolated test workload. Document which identities can configure, deploy, pause, or delete it; ownership and incident escalation; and how access is revoked or the workload is relocated.
2. **Cloudflare resource boundary:** Verify the selected account, Worker-name absence or existing resource identity, effective public ingress, route and trigger inventory, environment and applicable deployment roles. Allow resource-only creation **only** if independently verified absent, supported and separately authorized. No executable code deployment follows automatically.
3. **Data and credentials:** Identify whether the host may receive/process provider or tenant data. Define authorized data classes, retention, audit, breach/incident handling, confidentiality, access logs and removal obligations. Where applicable, execute an appropriate hosting/data-processing arrangement before moving data or secrets.
4. **Stripe test credential custody:** Approval must identify the Stripe test account, test-only realm, restricted read permissions actually supported, authorized key issuer/custodian, encrypted Worker secret binding `STRIPE_TEST_VERIFIER_RESTRICTED_KEY`, inventory revision/rotation and revocation procedure. Never transfer key material through GitHub or chat, never reuse a live/broad key.
5. **Financial and runtime controls:** No invoice modification, credit consumption, settlement, ledger mutation, production deployment or public endpoint. A separately authorized future read-only qualification must confirm `GET /v1/account` identity, scoped invoice `livemode=false` and trusted invoice binding. Source evidence remains point-in-time only.

## Evidence and execution status

| Evidence | Status |
| --- | --- |
| ECHO GRID independence with INFINICUS LLC hosting decision | **OWNER DECIDED** (2026-11-03) |
| Authorized Cloudflare account selected | **OWNER DECIDED**; runtime membership/reachability recheck PENDING |
| Cloudflare Worker inventory inspection | **NOT PERFORMED** |
| Signed/traceable cross-entity hosting and custody authorization | **PENDING** |
| Resource-only Worker creation | **NOT PERFORMED; authorization pending** |
| Inert Worker deployment and runtime identity attestation | **NOT PERFORMED; separate authorization required** |
| Restricted test-key issuance and secret binding | **NOT PERFORMED; separate authorization required** |
| Stripe identity or invoice API read | **NOT PERFORMED; separate authorization required** |

**Verdict:** GO for read-only Cloudflare account/Worker inventory inspection. **NO-GO** for Worker creation, deployment, credential provisioning and test-invoice retrieval until the applicable separate approvals and verified identity/permission gates are satisfied.

Related records: [Cloudflare preflight](S08_PRIVATE_VERIFIER_02_CLOUDFLARE_PREFLIGHT.md), [private verifier inventory](S08_PRIVATE_STRIPE_TEST_VERIFIER_INVENTORY.md), and [credential custody handoff](S08_PRIVATE_VERIFIER_02_PROVISIONING_CUSTODY.md).
