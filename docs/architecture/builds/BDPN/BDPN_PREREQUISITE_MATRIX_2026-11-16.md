# BDPN prerequisite matrix (read-only audit)

**Status: DOCUMENTATION ONLY.** Baseline `origin/main` @ `341e15a` (2026-11-16). Method: read the BDPN-01 / D-18 v1.1 documents and inspected the repository (schema, services, routes). **No BDPN code exists on main** (no profile, publication, discovery or entitlement table, route or service; latest migration before this audit was 0076). This audit authorizes nothing; BDPN implementation needs a separately approved scope.

Legend: **Implemented** (usable now), **Partial**, **Missing**, **Blocked** (cannot proceed until an owner decision or a prerequisite), **Ready** (could start once the scope is authorized).

## 1. Matrix
| # | Prerequisite | State | Evidence / note |
|---|---|---|---|
| 1 | Business identity (`businesses`, status `active/suspended/archived`, branches) | Implemented | `db/schema/businesses.ts`; D-18 OD-18 "active" meaning is still to be frozen from this schema |
| 2 | Business authorization (staff roles, business-wide vs branch, `requirePermission`, `requireBusinessWideAccess`) | Implemented | Tenant context binds business/branch; profile edit/submit permissions (D-02) do **not** exist yet |
| 3 | Platform moderation authority (code-owned platform permission pattern) | Partial | Pattern exists (`community-permissions`, NETWORK-01 `network-permissions`); the BDPN moderation permission (D-03) is not created |
| 4 | Business profile + revisions + opaque handle (BDPN-01A) | Missing | No table; design only. NETWORK-01 uses the same revision/digest discipline, so the pattern is proven |
| 5 | Manual identity verification (D-21) / published-profile eligibility predicate | Missing | Blocks business-authored Network posts (NETWORK-00 N-06) |
| 6 | Partner eligibility (Split 07/08 partner enrollment, credits) | Implemented (separate domain) | `partner-credits/*`; BDPN must not read or write it (BDPN is neutral discovery) |
| 7 | Consent (`consent_grants`, consent service/routes, partner consent) | Implemented | Versioned consent writer exists; remote-join consent (OD-17) and per-channel promotion consent (BDPN-02) are new and Missing |
| 8 | Loyalty ledger boundaries (business-isolated accounts/transactions; Community Points separate; broker integration) | Implemented | Verified by NETWORK-01 non-effect test; BDPN must add **no** path to these ledgers |
| 9 | Customer identity and sign-in (one global identity) | Implemented | CUSTOMER-AUTH S1-S4; recovery merged but disabled |
| 10 | Customer Community route and sections | Implemented | COMMUNITY-01 merged; BDPN-01D integration is design only |
| 11 | Network feed dependencies | Partial | NETWORK-01 (PR #474, official posts only) is pending; business posts need #4 and #5 |
| 12 | Plan / entitlement authority | Missing / Blocked | Plans exist (`subscription_plans`, `business_subscriptions`) but there is **no entitlement specification** (C-6); OD-14 unapproved; D-24 "which plans" undecided |
| 13 | Discovery read model + API (BDPN-01C) | Missing | Design only; must not reuse the unguarded `/businesses/:id/public` as publication proof |
| 14 | Remote enrollment (`loyalty.remote_enrollment`) | Blocked | Needs OD-17 amendment of Split 01 invariant 4, independent security review (B5), OD-21/22/23/11 |
| 15 | Community promotion (`community.promotion`) | Blocked | Needs entitlement spec (#12), content moderation (#3) and a separate BDPN-02 consent gate for any outbound send |
| 16 | Interest signals and aggregated demand | Blocked | Needs OD privacy decisions (dedup window, >=5 threshold, retention) |
| 17 | Migration governance (journal guard, per-block migrations) | Partial | OD-24 would replace D-19 "one migration"; until approved, the D-19 rule stands |
| 18 | Content policy for posts and profiles | Partial | Interim policy is a draft (D-16), not in force; needs owner/counsel approval and two named reviewers |

## 2. Ready for development once scope is authorized (no policy blocker)
- **BDPN profile foundation (G1A part 1):** profile + revision + handle tables, submit/approve state machine, platform moderation permission, with the D-01..D-15, D-21, D-22 decisions already recorded. Requires D-19 reconciliation (one migration vs OD-24) first.
- **Read-only discovery read model (G1A):** after the profile foundation exists; independent of plans if OD-1 is approved, otherwise plan-gated per D-24 (which is undecided).

## 3. Owner decisions that gate more than one block
1. **OD-1 / D-24:** is discovery plan-gated or universal? (The v1.1 lock says universal; D-24 says plan-gated; the amendment is not approved.)
2. **OD-14:** approve an entitlement specification and its authority (also needed by remote enrollment and promotion).
3. **OD-24 vs D-19:** one BDPN migration or per-block migrations.
4. **D-16:** approve the content policy and name two platform reviewers.
5. **OD-17:** approve the Split 01 invariant 4 amendment before any remote-join code.

## 4. What this audit did not do
Did not start BDPN, create tables, change permissions, or interpret unapproved proposals as policy. Nothing here is a security certification.
