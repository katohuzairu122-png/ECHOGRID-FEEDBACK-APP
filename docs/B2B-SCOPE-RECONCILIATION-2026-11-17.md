# B2B workstream — scope reconciliation (2026-11-17)

Status: **documentation only** (no code, schema, endpoint, migration or UI). Supersedes the baseline of `docs/B2B-ARCHITECTURE-RECONCILIATION.md` (main `9d92b33`), which stays as history.
Baseline: `origin/main` @ `3b11756dae0b13927a9ae86b01cc6e0846d6ca2f`; migration journal 80 entries (last `0079`).
Ownership: this file belongs to the B2B workstream. Community Feed, platform moderation, moderation history and customer Community interfaces (`apps/api/src/network`, `apps/api/src/community`) belong to the Community workstream and are not touched here.
Authorization context: development and testing only. No deployment, no migration execution, no merge, no production data change.

## 1. Evidence checked
- Owner decision record `BDPN_01_OWNER_DECISION_RECORD.md` (D-01..D-25), prerequisite matrix `BDPN_PREREQUISITE_MATRIX_2026-11-16.md`, D-18 v1.1 lock, grouped plan and contracts (all proposals, none approved), `docs/product/CLAUDE_CODE_WORK_QUEUE.md` section 3, and the 2026-11-12 B2B reconciliation.
- Repository search on main: no business-profile, discovery, partnership, partner-request, agreement or entitlement entity, route, service or UI exists. The only business-facing partner surface is the read-only terms page (P1, `/dashboard/billing/partner-terms`) and the existing settlement screens. NETWORK-01 (official posts) is Community-owned.
- Open PRs at this baseline: #497 (NETWORK-03 moderation history, Community-owned, untouched).

## 2. Inventory against the B2B scope list
| # | Scope item | State on main | Blocker | Decision / spec needed |
|---|---|---|---|---|
| 1 | Business network identity and profiles | **Not implemented** (BDPN-01A design only) | Owner decisions still open for the profile foundation: OD-1/D-24 (plan-gated vs universal discovery), OD-14 (entitlement specification), OD-24 vs D-19 (one migration vs per block), D-16 (content policy approval, two named reviewers) | Work queue section 3, "BDPN profile foundation" |
| 2 | Business discovery and partner eligibility | **Not implemented** | Needs item 1; discovery read model must not reuse unguarded `/businesses/:id/public` (D-25). Partner Credit eligibility (Splits 07/08) is a separate domain and BDPN must not read or write it | OD-1/D-24, OD-14 |
| 3 | Partnership requests, approval, rejection | **Not implemented, not specified** | No entity or policy exists; Split 09 was never written. Inventing it would invent partner-authorization policy, which is forbidden | Split 09 specification authorized by the owner (reconciliation decision 1) |
| 4 | Partnership lifecycle and termination | **Not implemented, not specified** | As item 3 | As item 3 |
| 5 | Partner authorization and tenant isolation | Tenant isolation and RBAC exist; partner enrollment is platform-admin plus business acceptance (Split 07) | Partner-to-partner authorization has no contract | As item 3 |
| 6 | Business network management interfaces | Partial: P1 terms page and `/dashboard/settlements` exist | Network section needs items 1-4; owner decision 4 (navigation position) open | Reconciliation decision 4 |
| 7 | Cross-business interaction APIs | **Not implemented, not specified** | No approved cross-business data contract; cross-business research (what one business may see of another's data) is undecided | Missing contract 5 in the 2026-11-12 document |
| 8 | Audit records and security controls | Exist for current domains (immutable audit, append-only guards) | Nothing new to audit until items 1-7 exist | Follows items 1-7 |
| 9 | Notifications and UI | Business UI for existing domains only | Network notifications need items 1-4; D-17 forbids view tracking | Follows items 1-7 |

## 3. Existing-backend candidates
| Block | Description | Status |
| --- | --- | --- |
| P1 | Business read-only Partner Program terms screen | Done on main (`docs/UI-PARTNER-TERMS-P1.md`); enrollment status still needs a new authorized read endpoint |
| S1 | Business survey-hosting screens on the existing staff routes `GET/POST /surveys`, versions, campaigns under `survey:view` / `survey:manage`; no cross-business reads | **Not built.** Listed as "UI only, one authorized block each" in the 2026-11-12 document, but no owner confirmation of S1 is recorded in the repository. It is outside the nine-item B2B list in this workstream's directive, so it is **not started** pending the owner's confirmation |

## 4. What was deliberately not done
- No commercial, privacy, settlement or partner-authorization policy was invented.
- No BDPN D-18 v1.1 feature (remote enrollment, interest, promotions) was started: the amendment is unapproved.
- No financial settlement, advertising or cross-business customer targeting.
- No Community-owned file was modified.

## 5. Owner decisions that unblock B2B development (in priority order)
1. Authorize the Split 09 specification (scope, consent and privacy model). It unlocks items 3-7.
2. Rule on OD-1 / D-24 and OD-14 (discovery gating and entitlement specification), and on D-19 vs OD-24 (migration shape). They unlock the profile foundation (items 1-2).
3. Approve the interim content policy (D-16) and name two platform reviewers.
4. Confirm whether S1 (business survey screens) is in scope for this workstream.
5. Confirm the position of the Network section in business navigation.

## 6. B2B completion matrix
| Group | Items |
| --- | --- |
| Completed and merged | P1 Partner terms screen (read-only); existing settlement screens; Splits 04-08 backends |
| Implemented but unmerged | None from this workstream (this document is the first B2B draft PR) |
| Blocked by owner decisions | Items 1-9 above (profile foundation by OD-1/D-24, OD-14, OD-24 vs D-19, D-16; items 3-7 by the missing Split 09 specification); S1 awaits confirmation |
| Not implemented | Items 1-9 above |

Nothing here is a security certification and nothing here authorizes implementation.
