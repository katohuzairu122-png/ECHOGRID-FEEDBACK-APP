# Echo Grid roadmap

**Status: WORKING ROADMAP, UPDATED 2026-11-12. DOCUMENTATION ONLY. No date is promised. Every row is a separate block that needs its own authorization.**
Reconciliation source baseline: `main` at `0321c40f303f967f4e02bf6caf0097c20e4243f1` (2026-11-12). Financial activation remains NO-GO. Current head must be rechecked before implementation.

## 1. Where things stand

- Merged to `main` and **not deployed**: Phase 1 public copy, Phase 2 customer loyalty wallet, D-C1 cashier permissions, cashier hardening, BDPN designs, NETWORK-00 design.
- Last deployed release: web-only run pinned to `b2f85ac`.
- Migration `0067` is pending in production and staging. Read-only check on 2026-11-12: 67 rows applied in each, all matching by timestamp, only `0067` pending. Some SQL hashes differ (59 and 54 of 67 match); cause open.
- D-C1 is merged but no reconciliation has run anywhere.

## 2. Tracks

### A. Coordinated release

| Step | Content                                                                                        | Gate                               |
| ---- | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| A1   | Investigate SQL-hash differences; verify restore readiness and environment targets (read-only) | Authorization                      |
| A2   | Seed the permission catalog; D-C1 Phase A dry run on staging, review, apply                    | Per-stage authorization            |
| A3   | Apply `0067` to staging and verify                                                             | Authorization, restore point first |
| A4   | Deploy the coordinated API and Web release to staging; D-C1 Phase B                            | Per-stage authorization            |
| A5   | Staging validation (cashier, manager, owner, customer wallet, landing)                         | Owner                              |
| A6   | Repeat for production                                                                          | Separate authorization per stage   |
| A7   | Re-verify public claims on the live site; real-device checks; native review of fr, es, ar      | Owner                              |

### B. Cashier and RBAC

D-C1 rulings (see `DC1_PROPOSED_OWNER_RULINGS.md`): staging first, keep custom roles until reviewed, accept the view-only narrowing, remove `business:view` and `branches:view` from Staff in a separate block, retire `loyalty:manage` later, no new feedback or messaging permissions. D-C2 name or phone customer search remains a separate owner decision.

### C. Positioning and Network

Phase 1 copy and Phase 2 wallet are merged. NETWORK-00 decision record, then publishing, then the Feed inside the Community tab, then customer posts (only after moderation capacity), business-to-business, commercial. All after BDPN discovery.

### D. Business discovery (BDPN)

Designs complete. Needs your open-question answers, D-16 and D-24. Then 01A migration, 01B service, 01C API, 01D UI, each its own block, flag off.

### E. Known issues

Messages page failure in production (cause unknown); duplicate-tier HTTP 500 was remediated in merged PR #378 (25/25 CI; production deployment not verified); limiter keying and wallet request volume (O-E1) remain.

### G. CUSTOMER-AUTH-01 (separate workstream)

Requirements and blocks: `docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md`. See also `docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_01_RECONCILIATION_2026_11_12.md` for the **proposed** D-B9/MG-02 ordering, refresh-token contract corrections and exact-head PG18 validation gates. PR #384's 01C document was missing from `main` and is being restored in the same **unmerged** documentation PR. PRs #385/#387 remain draft and not activated.

| Block | Content                                                                           | Gate                                                           |
| ----- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| G0    | Owner answers to CA-01 to CA-10                                                   | Owner                                                          |
| 01A   | Architecture and security assessment of the 90-day customer session (design only) | Authorization                                                  |
| 01B   | Data contract (design only)                                                       | Owner review                                                   |
| 01C   | Existing-customer migration plan (design only)                                    | Owner review                                                   |
| 01D   | API with new storage and a migration                                              | **Merge NO-GO** until D-B9/MG-02, security review, Gate 2/PG18 exact-head certification and staged release sequencing are approved |
| 01E   | Web registration, login, recovery, sessions                                       | Own authorization                                              |
| 01F   | Business-QR path with explicit join choice                                        | Own authorization                                              |
| 01G   | Remote enrollment                                                                 | Blocked until BDPN-01 is live and a D-18 amendment is approved |
| 01H   | Certification and progressive rollout                                             | Owner                                                          |

## 3. Suggested order

1. Now: your D-C1 rulings and the BDPN answers; authorize the read-only checks in A1; CUSTOMER-AUTH-01 G0 to 01C (documentation only).
2. Next: the staged release in A2 to A6.
3. After the release is stable: 01D to 01F, the D-C1 Staff cleanup (`business:view` and `branches:view`), BDPN implementation.
4. Last: remote enrollment, Network publishing and Feed, commercial.
