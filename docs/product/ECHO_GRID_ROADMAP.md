# Echo Grid roadmap

**Status: WORKING ROADMAP, UPDATED 2026-11-13. DOCUMENTATION ONLY. No date is promised. Every row is a separate block that needs its own authorization.**
Reconciliation source baseline: `main` at `532e65c4e554ccd1df53f38565b9ff5d81902f90` (2026-11-13, merge of PR #402). Financial activation remains NO-GO. Current head must be rechecked before implementation.

## 1. Where things stand

- **Production release (A6) completed 2026-11-13.** In order: restore point; permission catalog 24 to 34 keys; D-C1 Phase A (600 grants over 240 roles); messages fix for one business (6 grants); migrations `0067` and `0068` (run 43420468101); API and web deploy of `main` `532e65c4` (run 43421810874, every post-deploy check passed); D-C1 Phase B (298 removals over 60 Staff roles). Each stage was separately authorized, and the protected `production` environment required the owner's approval for the migration and for each deploy job. Production is at migration 69 of 69.
- **Staging** runs `main` `532e65c4` (deploy run 10). Staging had the full sequence first: snapshot, catalog seed, Phase A, `0067`, `0068`, Phase B, synthetic Staff user, and deploys.
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

### E. Known issues

- **Error 1102 "Worker exceeded CPU time limit" on echo-grid.uk (Block 0, root cause identified, observation pending).** Errors began within a minute of the web deploy of `main` `532e65c4` (version `f2ae60ee`) at 12:23:53 UTC on 2026-11-13. Cloudflare screenshots showed the account on **Workers Free (10 ms CPU limit)** with a median CPU of 16.88 ms on that version; 23 CPU-limit errors in 24 hours (older version `b3ef5ec8`: 8 of about 3,000; `f2ae60ee`: 15 of 388). Local measurements show old and new nearly equal per request, so the release raised an already-too-high error rate. Cloudflare's documentation confirms the Free limit and that server-rendered apps usually need Paid. The account is now on **Workers Paid (verified)** and the Web Worker was redeployed at 16:56 UTC as version `3087cbd8` (verified). **Observation (about 17:45 UTC): `3087cbd8` showed 0 errors over 62 invocations on Paid (Errors card, filtered to that version), so the fix is verified on a small sample; owner to certify Block 0.** CPU time per request reads inconsistently (103 ms, 288 ms, 416 ms vs about 17 to 19 ms locally) and is logged as an open observation to re-read under steady traffic (see incident report section 10b). Full record: `docs/architecture/builds/ACCESS-MODEL/WEB_1102_INCIDENT_REPORT.md`.
- **Staff Messages page "not available with your current access" (production).** Cause found and fixed 2026-11-13: one business ("Infinicus simulation engine v3") had roles created without `messages:view` and `messages:send`. Its Owner, Admin and Manager were granted them (6 rows); Staff deliberately were not.
- **Customer Messages page "Something went wrong".** Cause unconfirmed. The leading suspect was the shared IP-keyed limiter; the per-customer limiter (#398) is deployed to staging and production. A Cloudflare log lookup of reference 4208449032 would confirm. The messages page still shows a whole-page error instead of an inline retry; that fix is not built.
- **Cloudflare subscriptions to review (owner screenshot, 2026-11-13).** "R2 Paid" shows **"Expiring on Dec 11, 2026"**. Echo Grid's `apps/api/wrangler.toml` declares R2 buckets for production and staging (not used by code at runtime), so API deploys could fail if R2 lapses; decision pending, recommended to keep R2 (about $0 at current usage). "Workers PlanetScale" has no cancel option on the page (the PlanetScale database must be removed through its integration; Echo Grid and the Infinicus project do not use it). "Images Stream Basic" is subscribed but neither repository uses Cloudflare Images or Stream (verify billable usage before cancelling). "Teams Free Base" and "Observability" are in use or free; keep.
- **Rate limiting:** customer routes are now limited per customer (60 per minute). The global `API_RATE_LIMITER` is still IP-keyed and unchanged.
- **Email and SMS non-delivery on production:** unexplained. A read-only Resend and Twilio check is not yet authorized.
- Duplicate-tier HTTP 500 was remediated in merged PR #378.

### G. CUSTOMER-AUTH-01 (separate workstream)

Requirements and blocks: `docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md`. See also `docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_01_RECONCILIATION_2026_11_12.md` for the **proposed** D-B9/MG-02 ordering, refresh-token contract corrections and exact-head PG18 validation gates. PR #384's 01C document was missing from `main` and is being restored in the same **unmerged** documentation PR. PRs #385/#387 remain draft and not activated.

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

### H. WEB-PUSH-01 (future feature, design only)

Phone/desktop push notifications for new messages (WhatsApp-style), after the in-app unread indicators (PR #399). Design: `docs/architecture/builds/WEB-PUSH/WEB_PUSH_01_DESIGN.md`. Needs owner answers WP-1 to WP-6, a migration, owner-held VAPID keys, a sender on Workers, service-worker handlers and a staging device test. **Not built, not scheduled; each block needs its own authorization.**

### I. Messaging and notifications

Step 1, in-app unread indicators, is **done and in production** (#399): count badges on the Messages and My Rewards menu items, a dot on "More" on small screens, the tab title and app-icon badge, and a "new messages" mark on wallet cards. Customer polling relies on the per-customer limiter (#398). Step 2, phone push notifications, is track H and is not built.

### J. Everyday usability

Done: cashier form cleanup and one-field lookup; watermark; quicker customer feedback form (rating plus optional chips, one comment box) (#401); feedback inbox filters as dropdowns (#402, one choice per category and urgency). Not started: the signup page has no Echo Grid background watermark (owner screenshot, 2026-11-13); simplify the business-side form builder (Form name, Key, Question, Type, Required) for quick setup; the branch dropdown on the feedback inbox still drops the other filters when changed.

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
4. After the release is stable: CUSTOMER-AUTH-01 01D to 01F (gated), the D-C1 Staff cleanup (`business:view` and `branches:view`), BDPN implementation, and the WEB-PUSH-01 build when the owner schedules it.
5. Last: remote enrollment, Network publishing and Feed, commercial, AM-F.
