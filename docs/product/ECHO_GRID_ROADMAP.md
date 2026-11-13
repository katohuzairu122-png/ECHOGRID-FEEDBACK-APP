# Echo Grid roadmap

**Status: WORKING ROADMAP, UPDATED 2026-11-13. DOCUMENTATION ONLY. No date is promised. Every row is a separate block that needs its own authorization.**
Reconciliation source baseline: `main` at `532e65c4e554ccd1df53f38565b9ff5d81902f90` (2026-11-13, merge of PR #402). Financial activation remains NO-GO. Current head must be rechecked before implementation.

## 1. Where things stand

- **Production release (A6) completed 2026-11-13.** In order: restore point; permission catalog 24 to 34 keys; D-C1 Phase A (600 grants over 240 roles); messages fix for one business (6 grants); migrations `0067` and `0068` (run 43420468101); API and web deploy of `main` `532e65c4` (run 43421810874, every post-deploy check passed); D-C1 Phase B (298 removals over 60 Staff roles). Each stage was separately authorized, and the protected `production` environment required the owner's approval for the migration and for each deploy job. Production is at migration 69 of 69.
- **Staging** runs `main` `532e65c4` (deploy run 10). Staging had the full sequence first: snapshot, catalog seed, Phase A, `0067`, `0068`, Phase B, synthetic Staff user, and deploys.
- **Restore points** in the production Neon project: `snap-polished-mode-ata0w63g` (before migrations and grants), `snap-old-term-atbwadwh` (before Phase B), and the older 2026-11-09 snapshot.
- **Merged to `main` since the 2026-11-12 baseline:** cashier phone-or-scan lookup in one field (#392, D-C2b and D-C2c) and the always-ready scan field (#386); cashier form cleanup (#395) and QR photo upload removal (#380); Echo Grid watermark (#396); customer messaging thread tests (#397); per-customer rate limit (#398); unread-message indicators (#399); Web Push design (#400); quicker customer feedback form (#401); feedback inbox filter dropdowns (#402); and the customer-auth domain-layer blocks (#389 to #394), which are not wired and not enabled.
- **Open:** A7 (live-site checks, owner), the Error 1102 report in 2.E, and the items in sections 2.E to 2.J.
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

- **Error 1102 "Worker exceeded resource limits" on echo-grid.uk** (reported 2026-11-13 12:42:51 UTC, Ray ID a59ddbd89edbb903), after the production deploy. Open and uninvestigated: the cause cannot be seen without Cloudflare Workers Logs, and it is not yet known whether it is the web or API Worker, or one page or all. Mitigation if it persists: roll the web Worker back to its previous version in the Cloudflare dashboard (no code change; the database changes are additive).
- **Staff Messages page "not available with your current access" (production).** Cause found and fixed 2026-11-13: one business ("Infinicus simulation engine v3") had roles created without `messages:view` and `messages:send`. Its Owner, Admin and Manager were granted them (6 rows); Staff deliberately were not.
- **Customer Messages page "Something went wrong".** Cause unconfirmed. The leading suspect was the shared IP-keyed limiter; the per-customer limiter (#398) is deployed to staging and production. A Cloudflare log lookup of reference 4208449032 would confirm. The messages page still shows a whole-page error instead of an inline retry; that fix is not built.
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

Done: cashier form cleanup and one-field lookup; watermark; quicker customer feedback form (rating plus optional chips, one comment box) (#401); feedback inbox filters as dropdowns (#402, one choice per category and urgency). Not started: simplify the business-side form builder (Form name, Key, Question, Type, Required) for quick setup; the branch dropdown on the feedback inbox still drops the other filters when changed.

## 3. Suggested order

1. Now (owner): the live check in A7 as Owner, Staff and customer, and report whether Error 1102 recurs (with the page); answer D-C2, BDPN, CA-01 to CA-10 and WP-1 to WP-6 when ready; say whether to run the read-only Resend and Twilio check.
2. Next: investigate Error 1102 once the page and Worker are known; the inline retry for the Messages page; simplify the business-side form builder.
3. After the release is stable: CUSTOMER-AUTH-01 01D to 01F (gated), the D-C1 Staff cleanup (`business:view` and `branches:view`), BDPN implementation, and the WEB-PUSH-01 build when the owner schedules it.
4. Last: remote enrollment, Network publishing and Feed, commercial.
