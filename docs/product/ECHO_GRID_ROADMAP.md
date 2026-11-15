# Echo Grid roadmap

**Status: WORKING ROADMAP, UPDATED 2026-11-15 (DOCS-RECON-01). DOCUMENTATION ONLY. No date is promised. Every row is a separate block that needs its own authorization.**
Reconciliation source baseline: `main` at `eae88c702d682dec7bf4d32bf9918bc7a3f6dc7e` (2026-11-15, merge of PR #453), reconciled by DOCS-RECON-01 against GitHub pull-request, workflow-run and repository state. **Addendum (2026-11-15 17:44Z): `main` advanced to `bcd6c02f4f1faea1e2b877b4ecb395d5f456b64b` with customer-auth PRs #454, #455 and #456 (section 2.G.2); statements dated `eae88c7` below are corrected where those PRs changed them.** Sections not named in section 1 as refreshed still carry their 2026-11-13 text (baseline `532e65c4`, merge of PR #402). Financial activation remains NO-GO. **Nothing in this file is a security certification.** Current head must be rechecked before implementation.

## 1. Where things stand

- **Reconciled 2026-11-15 (DOCS-RECON-01), main `eae88c7`.** Open pull requests: none. Main CI run 43713469000 on `eae88c7`: `success`. Deploy staging run 43713775674 (`workflow_dispatch` on main, `eae88c7`, completed 2026-11-15 12:28Z): `success`, every step passed, including the read-only staging migration-state check, the API, web and cashier Worker deploys, the staging smoke and the cashier host-isolation smoke. **Staging therefore runs `eae88c7`.** This evidences build, deploy and host isolation only. It is **not** security verification (work queue section 2a).
- **Merged since the 2026-11-13 refresh (verified from PR metadata):** WORK-UX-01 W1 (#448), W2 (#443), W3 (#449); W4 browser acceptance infrastructure (#450); W5 mobile touch, keyboard focus and RTL regression coverage (#451); STG-SEC-02 staff login throttling option A (#439), review fixes (#445), H2 attribution-aware global API limiter (#447) and H3 throttle coverage with 120 s silent reset-email suppression (#452), **all now deployed to staging as part of `eae88c7`**; cashier security R1/R2 (#429 to #431) and C1 to C3 (#434 to #436); migration governance C4 (#437); BDPN D-18 v1.1 documents (#440, #441, #446); the customer email-login storage foundation (#432); the work queue (#444, #453). Cashier **production** release remains plan-only (#428) and unauthorized.
- **Migrations `0069` to `0073` are present in the repository** (journal had 73 entries at `eae88c7` and has 74 at `bcd6c02`, last `0073_customer_phone_free_challenges`): `0069_platform_customer_sanctions`, `0070_platform_customer_limited_access`, `0071_cashier_sessions`, `0072_customer_verified_login_email`, `0073_customer_phone_free_challenges` (development-only, see 2.G.2). **Present in the repository is not applied.** Staging: the work queue records `0072` applied, and the 2026-11-15 deploy's read-only migration-state step succeeded (its output was not read here). Production: the last verified state is 69 of 69 (through `0068`, recorded below); application of `0069` to `0073` in production is **not verified**, and `0073` is not recorded as applied to staging and must be confirmed read-only before any migration step.
- **CUSTOMER-AUTH-01 is merged and dormant: nothing is mounted or enabled** (sections 2.G and 2.G.2). **Customer authentication direction: email-first approved by the owner on 2026-11-15** (section 2.G.1). The email-first development PRs #454 to #456 merged after the `eae88c7` baseline and are development-only; **this document authorizes no activation**.
- **Production release (A6) completed 2026-11-13.** In order: restore point; permission catalog 24 to 34 keys; D-C1 Phase A (600 grants over 240 roles); messages fix for one business (6 grants); migrations `0067` and `0068` (run 43420468101); API and web deploy of `main` `532e65c4` (run 43421810874, every post-deploy check passed); D-C1 Phase B (298 removals over 60 Staff roles). Each stage was separately authorized, and the protected `production` environment required the owner's approval for the migration and for each deploy job. Production is at migration 69 of 69.
- **Staging** ran `main` `532e65c4` (deploy run 10) on 2026-11-13 and runs `eae88c7` as of 2026-11-15 (see the first bullet). Staging had the full sequence first: snapshot, catalog seed, Phase A, `0067`, `0068`, Phase B, synthetic Staff user, and deploys.
- **Restore points** in the production Neon project: `snap-polished-mode-ata0w63g` (before migrations and grants), `snap-old-term-atbwadwh` (before Phase B), and the older 2026-11-09 snapshot.
- **Merged to `main` since the 2026-11-12 baseline:** cashier phone-or-scan lookup in one field (#392, D-C2b and D-C2c) and the always-ready scan field (#386); cashier form cleanup (#395) and QR photo upload removal (#380); Echo Grid watermark (#396); customer messaging thread tests (#397); per-customer rate limit (#398); unread-message indicators (#399); Web Push design (#400); quicker customer feedback form (#401); feedback inbox filter dropdowns (#402); and the customer-auth domain-layer blocks (#389 to #394), which are not wired and not enabled.
- **Open:** A7 (live-site checks, owner), the Error 1102 report in 2.E, and the items in sections 2.E to 2.K.
- **R2 binding removed (2026-11-13):** nothing used the API's `UPLOADS` R2 binding. PR #408 removed it; staging run 43483250596 and production release run 43484634770 (CI gate, API, Web, post-deploy checks) succeeded on `main` `2ca37edb`. The two R2 buckets were kept (not deleted), so R2 Paid (expiring Dec 11, 2026) can lapse. No migration ran.
- **Production Web was redeployed at 16:56 UTC on 2026-11-13** (Web-only release run 43465438302, `main` `846fea9b`, verified), after the owner upgraded to **Workers Paid (verified on the Subscriptions page)**. The active version is `3087cbd8` at 100% of traffic. The earlier reported rollback was never applied. The error rate on the new version has not yet been observed under real traffic. No further Web release until Block 0 (2.K) is certified.
- **Merged after the first 2026-11-13 refresh:** the platform console guide (#404) and the access model design set (#405).
- **Resolved:** the earlier SQL-hash differences between environments are harmless. Older migrations were normalized after they had been applied, and Drizzle identifies a migration by its journal timestamp, which matched everywhere.

## 2. Tracks

### A. Coordinated release

| Step | Content                                                                                        | Gate                               | Status                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| A1   | Investigate SQL-hash differences; verify restore readiness and environment targets (read-only) | Authorization                      | Done. Hash differences explained as harmless.                                                      |
| A2   | Seed the permission catalog; D-C1 Phase A dry run on staging, review, apply                    | Per-stage authorization            | Done on staging.                                                                                   |
| A3   | Apply `0067` to staging and verify                                                             | Authorization, restore point first | Done on staging (`0068` also applied).                                                             |
| A4   | Deploy the coordinated API and Web release to staging; D-C1 Phase B                            | Per-stage authorization            | Done on staging.                                                                                   |
| A5   | Staging validation (cashier, manager, owner, customer wallet, landing)                         | Owner                              | Partly done by the owner; the signed-in checks have not been seen by Claude.                       |
| A6   | Repeat for production                                                                          | Separate authorization per stage   | **Done 2026-11-13**: snapshot, catalog, Phase A, messages fix, `0067` and `0068`, deploy, Phase B. |
| A7   | Re-verify public claims on the live site; real-device checks; native review of fr, es, ar      | Owner                              | **Open.** Live check as Owner, Staff and customer, and the unread badge on a real phone.           |

Production release record: migration run 43420468101 and deploy run 43421810874, both on `main` `532e65c4`. The release does not enable financial features.

### B. Cashier and RBAC

D-C1 is **applied in production and staging**: Staff roles now hold only `business:view`, `branches:view` and `loyalty:serve`; Owner, Admin and Manager gained `loyalty:serve`, `loyalty:adjust` and `loyalty:accounts:view`. The audit log records every role changed (303 reconcile rows in production). Remaining from the D-C1 rulings: remove `business:view` and `branches:view` from Staff in a separate block, retire `loyalty:manage` later, and no new feedback or messaging permissions.

D-C2 customer search by phone or scan in one field is merged (#392). Still open: the owner decisions D-C2-1 to D-C2-10, confirmation of the limits (limiter 10 per minute, throttle 8 per 10 minutes, caps 40 and 200 per day), D-C2e hardening, a PostgreSQL integration test for the lookup endpoints, and a staging test member for the phone lookup test.

### C. Positioning and Network

Phase 1 copy and Phase 2 wallet are merged. NETWORK-00 decision record, then publishing, then the Feed inside the Community tab, then customer posts (only after moderation capacity), business-to-business, commercial. All after BDPN discovery.

### D. Business discovery (BDPN)

Designs complete. Needs your open-question answers, D-16 and D-24. Then 01A migration, 01B service, 01C API, 01D UI, each its own block, flag off.

**D-18 v1.1 (remote enrollment, interest, promotions) stays gated on the owner.** The decision register OD-1 to OD-28 (`BDPN_D18_V1_1_AMENDMENT_AND_DESIGN.md` section 13) must be answered and an amendment approved before any build; Tier 1 first: OD-1, OD-14, OD-17, OD-18, OD-24. The 2026-11-15 documents (#440, #441, #446) are documentation only and their proposed rulings are **not** owner decisions. Nothing in the email-first ruling changes this. Remote enrollment also depends on authenticated customers, so section 2.G applies to it.

### E. Known issues

- **Error 1102 "Worker exceeded CPU time limit" on echo-grid.uk (Block 0, root cause identified, observation pending).** Errors began within a minute of the web deploy of `main` `532e65c4` (version `f2ae60ee`) at 12:23:53 UTC on 2026-11-13. Cloudflare screenshots showed the account on **Workers Free (10 ms CPU limit)** with a median CPU of 16.88 ms on that version; 23 CPU-limit errors in 24 hours (older version `b3ef5ec8`: 8 of about 3,000; `f2ae60ee`: 15 of 388). Local measurements show old and new nearly equal per request, so the release raised an already-too-high error rate. Cloudflare's documentation confirms the Free limit and that server-rendered apps usually need Paid. The account is now on **Workers Paid (verified)** and the Web Worker was redeployed at 16:56 UTC as version `3087cbd8` (verified). **Observation (about 17:45 UTC): `3087cbd8` showed 0 errors over 62 invocations on Paid (Errors card, filtered to that version), so the fix is verified on a small sample; owner to certify Block 0.** CPU time per request reads inconsistently (103 ms, 288 ms, 416 ms vs about 17 to 19 ms locally) and is logged as an open observation to re-read under steady traffic (see incident report section 10b). Full record: `docs/architecture/builds/ACCESS-MODEL/WEB_1102_INCIDENT_REPORT.md`.
- **Staff Messages page "not available with your current access" (production).** Cause found and fixed 2026-11-13: one business ("Infinicus simulation engine v3") had roles created without `messages:view` and `messages:send`. Its Owner, Admin and Manager were granted them (6 rows); Staff deliberately were not.
- **Customer Messages page "Something went wrong".** Cause unconfirmed. The leading suspect was the shared IP-keyed limiter; the per-customer limiter (#398) is deployed to staging and production. A Cloudflare log lookup of reference 4208449032 would confirm. The messages page still shows a whole-page error instead of an inline retry; that fix is not built.
- **Cloudflare subscriptions to review (owner screenshot, 2026-11-13).** "R2 Paid" shows **"Expiring on Dec 11, 2026"**. Echo Grid's `apps/api/wrangler.toml` declares R2 buckets for production and staging (not used by code at runtime), so API deploys could fail if R2 lapses; decision pending, recommended to keep R2 (about $0 at current usage). "Workers PlanetScale" has no cancel option on the page (the PlanetScale database must be removed through its integration; Echo Grid and the Infinicus project do not use it). "Images Stream Basic" is subscribed but neither repository uses Cloudflare Images or Stream (verify billable usage before cancelling). "Teams Free Base" and "Observability" are in use or free; keep.
- **Rate limiting:** customer routes are now limited per customer (60 per minute). The global `API_RATE_LIMITER` is still IP-keyed and unchanged.
- **Email and SMS non-delivery on production:** unexplained. A read-only Resend and Twilio check is not yet authorized.
- Duplicate-tier HTTP 500 was remediated in merged PR #378.

### G. CUSTOMER-AUTH-01 (separate workstream)

Requirements and blocks: `docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md`. See also `docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_01_RECONCILIATION_2026_11_12.md` for the **proposed** D-B9/MG-02 ordering, refresh-token contract corrections and exact-head PG18 validation gates. **Superseded status (2026-11-15):** the 01A to 01D-5 work is merged to `main` (table below and G.0), the 01C document was restored by #389, and nothing is wired or enabled. The earlier statements that #384 was missing and that #385/#387 were draft no longer hold.

| Block | Content                                                                           | Gate                                                                                                                               |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| G0    | Owner answers to CA-01 to CA-10                                                   | Owner                                                                                                                              |
| 01A   | Architecture and security assessment of the 90-day customer session (design only) | Authorization                                                                                                                      |
| 01B   | Data contract (design only)                                                       | Owner review                                                                                                                       |
| 01C   | Existing-customer migration plan (design only)                                    | Owner review                                                                                                                       |
| 01D   | API with new storage and a migration                                              | **Merge NO-GO** until D-B9/MG-02, security review, Gate 2/PG18 exact-head certification and staged release sequencing are approved |
| 01E   | Web registration, login, recovery, sessions                                       | Own authorization                                                                                                                  |
| 01F   | Business-QR path with explicit join choice                                        | Own authorization                                                                                                                  |
| 01G   | Remote enrollment                                                                 | Blocked until BDPN-01 is live and a D-18 amendment is approved                                                                     |
| 01H   | Certification and progressive rollout                                             | Owner                                                                                                                              |

#### G.0 State on `main` `eae88c7` (verified by repository inspection; see G.2 for later changes)

| Component | PR | State |
| --- | --- | --- |
| 01A architecture and security assessment; 01B data contract; 01C existing-customer migration plan; reconciliation record | #381, #382, #384, #389 | Merged, documentation. 01C restored on `main` by #389 |
| 01D-1 session token primitives and pure session policy | #385 | Merged, **not wired** |
| 01D-2 migration `0068` (credentials, sessions, refresh tokens, auth events), repositories, legacy-JWT cutoff | #387, #390 | Merged. `0068` applied to production on 2026-11-13 (section 1 of the 2026-11-13 text), **tables empty**, no route writes to them |
| 01D-3 customer session service | #391 | Merged, **not wired** |
| 01D-4a password auth domain layer (phone-proof based) | #393 | Merged, **not wired** |
| 01D-5 customer auth rate limits | #394 | Merged, **not wired**; no `CUSTOMER_AUTH_RL_*` binding is declared in `wrangler.toml`; budgets, namespace ids and source identification undecided |
| Customer email-login storage foundation (`login_email`, `login_email_verified_at` on `customer_credentials`, migration `0072`) | #432 | Merged. Repository support only. Its own description lists the registration endpoint, email verification and sign-in, and authenticated Twilio phone attachment as **not yet implemented** |
| 01D-4b routes, 01D-6 middleware and kill switches, 01E to 01H | none | **Not started** |

Evidence for "not wired": at `eae88c7` no route or middleware imports the session service, the password auth service or the rate limiter (only the modules themselves, their tests and the optional environment typings reference them); `customerAuthenticate` still verifies only the legacy 90-day customer token; the existing OTP routes and the shared `OTP_RATE_LIMITER` are unchanged.

#### G.1 Owner ruling CUSTOMER-AUTH-EMAIL-01 (2026-11-15): email-first customer authentication

**Ruling.** The owner approved email-first customer authentication (instruction accompanying DOCS-RECON-01). **This records a direction only.** It does **not** authorize authentication routes, schema changes, migrations, secrets, deployment or any change to the merged phone-first code. All existing implementation and architecture are preserved by this document until a separate development block is authorized. (PRs #454 to #456 were developed and merged separately after this analysis's baseline; see G.2.)

**Reconciliation of the merged phone-first components against the email-first direction** (analysis from repository inspection at `eae88c7`; this document builds nothing, and rows are annotated where #454 to #456 changed them):

| Component (state) | Email-first impact | Change a future authorized block would need |
| --- | --- | --- |
| `customers` identity table: `phone` is `NOT NULL UNIQUE`; `email` is an editable, unverified, non-unique profile field | A customer who registers by email has no phone yet, but a customers row cannot exist without one | Decide how a phone-less customer is represented (owner question E3); either relaxes the identity table's phone constraint (touches finders, OTP find-or-create, cashier phone lookup, QR, messaging, consent) or adds a different record. **Superseded in part: #454 made `phone` nullable (G.2)** |
| `customer_credentials` with `login_email`, `login_email_verified_at`, unique index, verified-pairing check (lowercase and trimmed enforced) | Already the right shape for the sign-in identity, and separate from the profile email | Keep. Normalization beyond lowercase and trim is undefined (E5). The credential still needs a customers row (above) |
| Email verification artifacts | None exist: only a verified address can be stored, so a pending or unverified address, a code or link hash, expiry and attempt counters have no home | New storage (migration), single use, hashed at rest. **Superseded in part: #454 adds `customer_auth_challenges` (G.2)** |
| 01D-3 session service (customer-id keyed) | Largely reusable unchanged: sessions, rotating refresh, replay scope, revocation, legacy-token cutoff, step-up | `customer_sessions.auth_method` and `customer_auth_events.event_type` are closed CHECK lists built around OTP and phone events; they need email values (migration). **#456 adds a dormant rotating-cookie transport; the deployed router keeps the legacy verifier by default (G.2)** |
| 01D-4a password auth service | Every creating or resetting flow requires a fresh `VerifiedPhoneProof`; login is phone plus password; recovery is a phone OTP | An email proof type and email login, registration and recovery; the password policy module is reusable (the phone-in-password rule becomes an email rule). **#455 adds unmounted email registration and login handlers (G.2)** |
| 01D-5 rate limits | Dimensions are phone, source, phone+source, global and customer; no email dimension and no email-send ceiling | Email dimensions (hashed, normalized), a global email-send ceiling, new surfaces. Bindings are not yet declared, so nothing deployed changes. **#455 adds a Durable Object adapter for email counters and a fail-closed source resolver; neither is bound (G.2)** |
| Legacy 90-day phone OTP token and existing OTP routes | Remain the only live customer sign-in (still the deployed default after #456) | Existing customers attach and verify an email after a fresh phone OTP; the legacy cutoff semantics are unchanged. The 01C plan assumes a phone-OTP enrollment and would need revising (E8) |
| Phone attachment | Becomes a later, authenticated step (Twilio Verify) | An attached phone that already belongs to an existing customer creates a linking or merge question (E4) |
| Features that assume a verified phone | Cashier phone lookup (D-C2), SMS notifications, business-QR check-in, customer QR | Define behavior for customers without a verified phone (E2). No change is made here |
| BDPN D-18 remote enrollment | Depends on authenticated customers | Unchanged and still gated on OD-1 to OD-28 |

**Dependencies.**
1. A working **production email path**. Section 2.E records email and SMS non-delivery on production as unexplained, and a read-only Resend and Twilio check is not yet authorized. Email-first cannot be relied on until this is resolved.
2. Owner answers E1 to E9 below, plus the still-open CA-01 to CA-10, D-B1 to D-B9 and MG-01 to MG-10 from the CUSTOMER-AUTH-01 documents.
3. Rate-limit budgets, Cloudflare namespace ids and source identification (O-E1). H2 (#447) introduced signed client attribution for the API's global limiter, and #455 builds a fail-closed email source resolver on it; whether it answers O-E1 for customer routes has **not** been verified live.
4. A Twilio Verify budget and test plan for phone attachment (CA-10).

**Migration considerations.** At `eae88c7` the journal had 73 entries; `0073` has since been used by #454 (74 entries), so the next entry is **`0074`**. Any change should be additive and must not disturb `0068` to `0073`. Done in development by #454 and not applied: a nullable `customers.phone` and email challenge storage. Possibly still needed (none authorized, not verified): widen the `auth_method` and `event_type` CHECK lists, which `0073` did not change. Keep these separate from BDPN migrations. Each step follows the established sequence: confirm the real migration state read-only (production `0069` to `0072` is unverified), restore point, staging, verification, then production, each with its own owner authorization. Migration governance is centralized (#437), so pins are not hard-coded per file as they were for `0068`.

**Security implications.**
- Email becomes the primary sign-in and recovery factor, so a compromised mailbox is account takeover, and until a phone is attached there is no second factor. High-risk actions need a step-up policy.
- Registration and recovery must answer uniformly, so they do not reveal whether an address is registered. The phone flow could rely on proving the phone first; email must do the equivalent.
- Verification secrets: single use, high entropy, hashed at rest, short expiry. Mail scanners can fetch links automatically, so entering a code or confirming by a POST is safer than a bare link.
- Sending email costs money and can be abused to harass an address or damage the sender's reputation. Per-address, per-source and global ceilings are needed, and sender domain authentication status is unknown.
- Linking a phone that already belongs to an existing customer can expose that customer's memberships and points. It needs an explicit policy, never a silent merge.
- Recycled or mistyped addresses are the email analogue of phone recycling; the residual risk moves, it does not vanish.
- The login email is personal data separate from the profile email (migration `0072`). Retention and privacy decisions D-B1 and D-B2 remain open.

**Owner questions (answer before a design block can be completed).**
- **E1** Is phone sign-in kept for existing customers, during and after the transition, or retired?
- **E2** Must an email-first customer verify a phone, and when (never, before joining a business, before cashier or QR features)?
- **E3** How is a customer without a phone represented (phone made optional on the identity table, or another record)? **Partly answered in code by #454 (phone nullable, unique kept); the owner decision is not recorded in these documents. Please confirm and record it.**
- **E4** When an email-first customer attaches a phone that already belongs to an existing customer: merge, refuse, or support-assisted?
- **E5** Email normalization beyond lowercase and trim: plus-addressing, dots, Unicode and IDN domains, disposable-domain policy.
- **E6** Verification mechanism (code or link) and lifetimes.
- **E7** Recovery rules when both email and phone exist: which channel, whether the other is notified, which step-up.
- **E8** What happens to the merged phone-first code and the 01C plan: keep as the existing-customer path, extend, or retire and rewrite.
- **E9** Authorize a read-only check of why production email and SMS are not delivered, and decide the sender and domain setup.

**Authorization boundary.** Activation of any email-first or rotating-session path (mounting routes, enabling rotating cookies, binding namespaces, applying `0073`, any deployment) needs separate owner authorization. The development PRs #454 to #456 are merged but dormant (G.2). This document authorizes none of it.

#### G.2 Post-baseline changes: `eae88c7` to `bcd6c02` (merged 2026-11-15, verified 2026-11-15 17:44Z)

Three customer-auth pull requests merged after the baseline this reconciliation was written against. Main CI succeeded on each merge commit (runs 43724406700, 43736314871 and 43740669655). They are **development-only**: the email and rotating-session routers remain unmounted in the deployed application, and the deployed router keeps its legacy default (PR #456 and `docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_S2_R2_READINESS.md`). No staging deploy newer than run 43713775674 (`eae88c7`) appears in the workflow runs, so **staging is not recorded as running these changes**.

| PR | Merged (UTC) | What it adds (verified in the repository unless marked) |
| --- | --- | --- |
| #454 S1 | 14:26 | Migration `0073_customer_phone_free_challenges` (journal now 74 entries): `customers.phone` made **nullable** with its unique constraint retained, and a new `customer_auth_challenges` table (digest-only, purpose-bound: `email_registration`, `email_link`, `email_recovery`, `email_change`, `phone_attach`, `phone_change`; attempt cap of 5; expiry and consumption checks) with a conditional-update repository. The migration file states it is never to be executed outside disposable tests without separate approval. **Not recorded as applied anywhere** |
| #455 S2 | 16:35 | Isolated email registration and login handlers (digest-only proof issuance, serialized resend suppression, atomic proof consumption with verified credential creation), plus a Durable Object adapter for long-window email counters and a fail-closed source resolver built on the existing signed Web Worker attribution. **Unmounted; no Worker binding or deployment change** (per the PR) |
| #456 S2-R2 | 17:21 | Rotating customer cookie transport, `customerAuthenticate` able to accept an optional rotating-session service while the **deployed router keeps the legacy verifier by default**, and an origin-checked Web BFF refresh and logout path, all dormant. The readiness document lists the activation prerequisites: a dedicated Durable Object namespace for the email limiter, signed source attribution with a separate keyed digest, a distinct customer-session signing key, and an authenticated server-to-server BFF transport |

What this changes in the reconciliation above:
- The identity-table conflict in G.1 is **resolved in code** for the data model: a customer row can now exist without a phone. The owner decision behind it is **not recorded in these documents**. PR #454 cites owner-approved "D1/D2"; owner question E3 should be answered and recorded here.
- Email verification storage now exists (`customer_auth_challenges`). Widening the session `auth_method` and event `event_type` CHECK lists is **not** done by `0073`; whether the new code needs it was not verified here.
- The next free migration number is **`0074`**, not `0073`.
- "01D-4b routes not started" is superseded: the 01D-4b S1, S2 and S2-R2 slices are merged and dormant. **Mounting, binding namespaces, applying `0073`, enabling rotating cookies and any deployment remain unauthorized by these documents.**
- Questions E1, E2 and E4 to E9 are not recorded as answered.
- Production and staging state of `0073`, and of `0069` to `0072` in production, remains **unverified**.

#### G.3 Post-baseline: S3 email link (#457) and R1 remediation (2026-11-15)

PR #457 (link a verified email to existing phone-only customers) merged at 17:59Z as `f1c04de`, after `bcd6c02`. It is development-only and unmounted. An independent read-only review raised seven findings; CUSTOMER-AUTH-01D-4b-S3-R1 remediates them in a follow-up pull request (hashing outside the transaction, bounded password guesses, internal OTP-retired reason, row-count check, tests). **Owner decision E10 approved 2026-11-15:** for a customer with a linked verified email, email is the routine login and phone OTP must not authenticate; the verified phone stays associated and may be one recovery factor, but phone possession alone must never reset a password, replace the email credential, issue a session or remove a factor. Recovery is a separate, unauthorized future block, **CUSTOMER-AUTH-01D-4b-S4 Secure Account Recovery** (proposed scope, gates and open decisions in `CUSTOMER_AUTH_S3_EMAIL_LINK.md` sections 7 and 8; not implemented). Repository inspection found one conflict in dormant code, the phone-proof-only `recoverPassword` (01D-4a, no caller); **CUSTOMER-AUTH-RECOVERY-GUARD-01** enforces E10-B at the service boundary (a customer with a verified login email cannot be recovered by phone alone; fails closed, no new route or schema). Phone-only recovery for customers without a linked email is unchanged and still unmounted. Activation prerequisites remain in the S3 document. No activation is authorized.

### H. WEB-PUSH-01 (future feature, design only)

Phone/desktop push notifications for new messages (WhatsApp-style), after the in-app unread indicators (PR #399). Design: `docs/architecture/builds/WEB-PUSH/WEB_PUSH_01_DESIGN.md`. Needs owner answers WP-1 to WP-6, a migration, owner-held VAPID keys, a sender on Workers, service-worker handlers and a staging device test. **Not built, not scheduled; each block needs its own authorization.**

### I. Messaging and notifications

Step 1, in-app unread indicators, is **done and in production** (#399): count badges on the Messages and My Rewards menu items, a dot on "More" on small screens, the tab title and app-icon badge, and a "new messages" mark on wallet cards. Customer polling relies on the per-customer limiter (#398). Step 2, phone push notifications, is track H and is not built.

### J. Everyday usability

Done: cashier form cleanup and one-field lookup; watermark; quicker customer feedback form (rating plus optional chips, one comment box) (#401); feedback inbox filters as dropdowns (#402, one choice per category and urgency). Not started: the signup page has no Echo Grid background watermark (owner screenshot, 2026-11-13); simplify the business-side form builder (Form name, Key, Question, Type, Required) for quick setup; the branch dropdown on the feedback inbox still drops the other filters when changed.

### L. PLATFORM-CUSTOMERS-01 (merged in #413) and follow-up

Platform "Customers" list and moderation per the 2026-11-13 D3 amendment (see ACCESS_MODEL_01_DESIGN.md section 3a): masked list, find by id or full phone, warn, limit, suspend (timed), ban and lift, all audited, admin-only actions, suspended or banned customers lose access to every business. **Follow-up (draft PR, development only):** limited-access state (migration `0070`, enforced when joining a business and taking part in surveys) and the impersonation setting (`PLATFORM_IMPERSONATION_ENABLED = "true"`, owner option b). **As of 2026-11-13 migrations `0069` and `0070` were not applied. As of `eae88c7` they are present in the repository journal with `0071` and `0072`; their application is recorded for staging (`0072`, work queue) and is not verified for production (section 1).** Not included: revealing personal details (needs MFA and a reason), export, and enforcement of limits on loyalty feedback rewards, Community Points redemption and the Community feed (those flows are not wired).

### K. Access model, privileged-access security and Web stability (designed, not built)

Documents (merged): `docs/architecture/builds/ACCESS-MODEL/ACCESS_MODEL_01_DESIGN.md` (three audiences, two places each, chooser after any authentication, separate customer and staff identity domains, owner-ratified decisions D1 to D6, recorded 2026-11-13), `ACCESS_SEC_01_ASSESSMENT.md` (platform administrator security) and `WEB_1102_INCIDENT_REPORT.md`. The decisions D1 to D6 are **proposed and not yet ratified by the owner**. Also see `docs/PLATFORM-CONSOLE-GUIDE.md`.

| Block | Content                                                                                                                   | Gate                                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 0     | WEB-1102: diagnose the CPU-limit regression, confirm versions, certify a fix                                              | **NOT certified.** Fix verified on a small sample, but staging showed an unexplained CPU-limit error on `GET /` (incident report 10b and 10c) |
| 1     | ACCESS-SEC-01: application MFA (and optionally Cloudflare Access), role provisioning, break-glass, impersonation decision | **Ruled 2026-11-13:** API-enforced MFA first, Cloudflare Access later; break-glass with conditions; impersonation to be disabled by feature flag (Option A). Not built. |
| 2     | AM-A: D1 to D6 ratified by the owner on 2026-11-13                                                                         | Recorded in ACCESS-MODEL-01 section 3a; closes when this reconciliation is merged |
| 3     | AM-B: post-authentication "Where to?" chooser (web only)                                                                  | Own authorization; after block 0                                     |
| 4     | AM-C: platform business area (customer counts, community, survey oversight, reports and support, legal status)            | Own authorization; requires block 1 enforced                         |
| 5     | AM-D: split the business area into console and dashboard                                                                  | Own authorization                                                    |
| 6     | AM-E: customer Loyalty and Community destination selection                                                                | Own authorization                                                    |
| 7     | AM-F: platform-created surveys, legal requests, any approved privileged support (including impersonation)                 | Not in version 1                                                     |

Findings recorded from the investigation: impersonation is already implemented (support and admin) although version 1 does not approve it; no stored terms-acceptance record exists; customer password login is not wired and the `0068` tables are empty; platform roles can only be set by a script or directly in the database, and production has one active platform admin.

## 3. Suggested order

1. Now (owner): send the remaining Cloudflare evidence for Block 0 (successful staging request CPU time; production Settings; staging `GET /` recheck) (plan and CPU limit, CPU time per Worker version, Workers Logs for the Ray ID, active Web version); decide on MFA and the live impersonation capability (Block 1); the live check in A7; answer D-C2, BDPN, CA-01 to CA-10 and WP-1 to WP-6 when ready.
2. Next: finish Block 0 (explain the staging CPU-limit error and certify), then write the ACCESS-SEC-01 build plan (API MFA, break-glass, impersonation flag). AM-B and later blocks need separate authorization, and no new Web feature goes to production until Block 0 is certified.
3. After that: AM-B chooser, AM-C platform business area, AM-D console and dashboard split, AM-E customer chooser; the inline retry for the Messages page; simplify the business-side form builder.
4. After the release is stable: CUSTOMER-AUTH-EMAIL-01 owner review and activation gates (owner ruling 2026-11-15; development PRs #454 to #456 merged and dormant; sections 2.G.1 and 2.G.2), then CUSTOMER-AUTH-01 01E to 01F reconciled to email-first (gated), the D-C1 Staff cleanup (`business:view` and `branches:view`), BDPN implementation, and the WEB-PUSH-01 build when the owner schedules it.
5. Last: remote enrollment, Network publishing and Feed, commercial, AM-F.
