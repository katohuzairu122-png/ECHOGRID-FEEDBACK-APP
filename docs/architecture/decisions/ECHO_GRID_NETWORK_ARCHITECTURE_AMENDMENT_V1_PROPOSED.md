# ECHO GRID — Network Architecture Amendment v1.0 (NETWORK-00)

**Status: PROPOSED — NOT LOCKED. DESIGN ONLY (owner-authorized: "NETWORK-00 design only").**
No code, schema, endpoint, UI, translation, configuration, migration, release, marketing or financial change is made or authorized by this document. It becomes binding only if the owner approves it as a versioned decision record.

- Baseline: `origin/main` @ `7fd8bfe8fa827990ee5b960c55d42946a1e8987e`.
- Relationship to locked records: **extends, does not supersede**, BDPN v1.0 (`ECHO_GRID_BUSINESS_DISCOVERY_PROMOTION_NETWORK_V1.md`), Split 05 (Community), Split 06 (settlement), Splits 07 and 08 (Partner Credits, billing). Any conflict is listed in section 6 and stops for an owner decision; nothing is silently overridden.
- Companions: `builds/NETWORK/NETWORK_00_CONTENT_MODEL_AND_ACCESS.md`, `NETWORK_00_MODERATION_AND_GOVERNANCE.md`, `NETWORK_00_PHASING_THREATS_AND_TESTS.md`.
- Sources: Claude Proposal A (#370), the ChatGPT Network Expansion proposal and its unified proposal, and the owner's public-claims policy (claims must describe deployed behaviour).
- `N-xx` = decisions proposed here and OPEN. `D-xx` = the BDPN decision record. Nothing marked OPEN is decided.

## 1. Purpose

Define how Echo Grid grows from a loyalty platform into a connected customer-business network **without** weakening customer identity, tenant isolation, consent, or financial separation. This record fixes the rules that every later NETWORK block must obey, so each block can be small and independently reviewable.

## 2. Scope

| In scope (designed here)                                                                                      | Out of scope (not designed, not authorized)                                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Echo Grid official publisher; verified business posts; a signed-in customer feed; follow a published business | Customer-created posts, comments, shares, rich media (gated, section 7)                                      |
| Content ownership, visibility, moderation, reporting, audit                                                   | Business-to-business network (needs its own Split 09 specification; only the isolation boundary is set here) |
| How the above fits BDPN, Split 05, Split 06, Splits 07 to 08                                                  | Sponsored placement, advertising, paid network plans, analytics products                                     |
| Phasing, threats, tests, release and rollback                                                                 | Outbound promotion by email, SMS or push (BDPN-02 to 04 and a separate consent contract)                     |

## 3. Domains and ownership (what must never merge)

| Domain                                              | Owner                        | Rule                                                                                                                  |
| --------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Global customer identity                            | Identity domain              | One account; never an exportable audience                                                                             |
| Business loyalty (accounts, tiers, rewards, ledger) | Each business                | Unchanged. Network activity never reads or writes it                                                                  |
| Community membership and Community Points           | Split 05                     | **Network engagement never awards, adjusts or redeems points**                                                        |
| Orphan settlement                                   | Split 06                     | Untouched; consent-gated as today                                                                                     |
| Partner Credits, subscriptions, billing             | Splits 07 to 08              | Untouched. No post, follow, view or ad purchase creates credits, discounts or entitlements                            |
| Business discovery profile                          | BDPN-01                      | Network posts require a live, published, eligible profile; the profile is the identity of the business on the network |
| **Network content (posts, follows, reports)**       | **New: Network domain**      | Defined in the content-model companion. Platform-governed, business-authored                                          |
| B2B resource and service profiles                   | Split 09 (not yet specified) | Separate storage and separate permissions; only the boundary is set here (section 5)                                  |
| Transactional notifications                         | Existing                     | **No new event type is added.** Posts and follows notify nobody in v1                                                 |
| Marketing consent                                   | BDPN-02                      | Unchanged. Following a business or reading a feed is never marketing consent                                          |

## 4. Product surfaces and naming

| Surface                            | Audience                  | Working name                              | Status            |
| ---------------------------------- | ------------------------- | ----------------------------------------- | ----------------- |
| Existing membership and points hub | Customers                 | **Community** (one top-level tab)         | Exists, read-only |
| Customer content stream            | Signed-in customers       | **Feed** (inside Community, not a tab)    | Not built         |
| Business publishing area           | Authorized business users | **Publish** (working name)                | Not built         |
| Echo Grid official account         | Customers                 | "Echo Grid" with a visible official badge | Not built         |
| Business-only network              | Verified businesses       | **Business Network** (Split 09)           | Not specified     |

**Owner direction (2026-11-12): Feed and the existing Community hub share ONE top-level customer navigation tab, `Community`.** `Feed` is an internal subsection, not a second primary tab. Community Points and membership remain the exclusive responsibility of Split 05; feed data and permissions remain in the separate Network domain.

### 4.1 One-tab composition — owner-directed, design only

- **Customer navigation:** Preserve the single existing `Community` destination at `/loyalty/dashboard/community`. Do not add a second top-level `Feed` item or duplicate the Community menu.
- **Inside Community:** Provide an internal `Feed` subsection for approved posts and an internal `Points & Membership` subsection for the existing Split 05 functionality. This is a presentation composition, **not** a merging of tables, points, membership, identity or authorization.
- **Existing behavior:** Until the feed is independently implemented and activated, the Community destination continues to display the existing read-only membership and points hub; no dead Feed control or "coming soon" claim is displayed by default.
- **Route sketch (not approved implementation):** Keep `/loyalty/dashboard/community` as the stable existing hub entry point, and place future feed UI under a nested route such as `/loyalty/dashboard/community/feed`. The final route contract requires review in NETWORK-02; existing bookmarks and Points navigation must remain valid.
- **Backend isolation:** The feed keeps `/network/*` endpoints and `network_*` storage, not Split 05 `/community/*` APIs or points tables. `N-17` therefore reserves the `network` API/storage namespace, but **does not prohibit** a Community-nested customer UI route.
- **Security and launch:** A `Feed` subsection is visible only when the separately approved per-environment feed flag is enabled and customer authorization succeeds. A disabled, empty, erroneous or withdrawn feed must not hide or interrupt existing Community Points/membership functionality. Each subsection retains its own permission and data contracts.
- **Not authorized:** No production UI, navigation, routing, schema, API, release or activation change follows from this direction. All other `N-xx` decisions remain pending owner approval.

## 5. Non-negotiable invariants (binding on every NETWORK block)

1. **Fail closed.** Any missing or ambiguous fact (profile eligibility, post state, moderation state, account state) means "not visible".
2. **Platform decides publication; the business decides content.** No business code path can make content visible.
3. **Immutable evidence.** What a moderator approved is exactly what is shown, proven by a content digest (the BDPN-01B pattern).
4. **No cross-tenant reads.** No feed, follow or report path can expose, count by identity, rank by, or infer another business's customers.
5. **A follow is not a membership, not consent, and not a conversation.** It creates no loyalty account, no marketing grant, no messaging channel and no notification.
6. **No tracking.** D-17 stands: no view counters, no per-customer reading history, no click tracking. Engagement counts, if any are authorized later, count explicit customer actions only.
7. **No personalization or engagement ranking in v1.** Deterministic, reverse-chronological order.
8. **No synthetic data.** No invented ratings, reach, popularity or "trending".
9. **Plain text only in v1.** No HTML, markdown, embedded media, mentions or hashtags.
10. **B2B isolation.** Business-to-business content lives in separate tables behind separate permissions. A feed endpoint can never return it; a customer endpoint can never reach it.
11. **No financial effect.** No network action creates Partner Credits, Community Points, subscription discounts or settlement obligations.
12. **Every material action is audited** in the existing `audit_log` (actor, action, entity, metadata).
13. **Signed-in customers only** (D-09). No anonymous browsing in v1.
14. **Activation is a switch.** A per-environment flag, default off (D-20 pattern), per block.

## 6. How this amends or interacts with BDPN v1.0 (explicit)

| BDPN v1.0 reference                                | Effect of this amendment                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Section 1, canonical flow                          | **Unchanged.** Posts are not promotions: nothing is sent outward                                                                                   |
| Section 2, ownership table                         | Adds one row (Network content, section 3 above). No existing row changes                                                                           |
| Section 3, Mode A (in-app discovery)               | Mode A stays profile discovery. The feed is an **additional, separately authorized content capability nested inside the existing customer Community tab** ("Mode C: published content"), not consent and not promotion |
| Section 4, business announcement contract (future) | NETWORK-01 is the in-app, moderated realization. It does **not** include outbound delivery, which remains BDPN-02 to 04                            |
| Section 5, roadmap                                 | NETWORK blocks are inserted **after** BDPN-01 (published profiles), never before it                                                                |
| Section 7, open decisions                          | Unchanged and still open (consent wording, personalization, caps)                                                                                  |
| Section 8, change control                          | This record is the "new owner-reviewed, versioned decision record"; it supersedes **nothing**                                                      |

Interactions with BDPN-01 decisions that this record **depends on or must not weaken**:

| Decision                          | Dependency or constraint                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| D-09 signed-in customers only     | Applies to the feed                                                                            |
| D-10 opaque handle                | Posts use opaque handles; internal ids never appear                                            |
| D-12 no caching                   | `private, no-store` on feed responses                                                          |
| D-14 every edit reviewed          | Proposed to apply to posts (N-03)                                                              |
| D-17 no tracking                  | Applies; limits analytics (N-14)                                                               |
| D-18 informational join text only | Posts and follows must not add a "join" action. A post may not embed a join link in v1         |
| D-21 manual verification          | Business identity stays manually verified                                                      |
| D-24 plan gating                  | **Unresolved. A network entitlement rule cannot be decided before D-24**                       |
| D-16 content policy               | Interim policy must be extended for posts before any business publishes (moderation companion) |

## 7. Proposed decisions (all OPEN, owner decides)

| ID   | Decision                                              | Options                                                                            | Recommendation                                                                                |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| N-01 | Customer navigation and content name                  | Separate tabs or one Community tab with an internal Feed                           | **Owner-directed: one Community tab; Feed subsection**. Final internal labels remain reviewable |
| N-02 | Storage shape                                         | One shared content envelope for all domains, or separate storage per domain        | One envelope for customer-visible posts (platform and business); **B2B in separate tables**   |
| N-03 | Moderation timing for business and official posts     | Pre-moderation (approve before visible) or post-moderation (visible then reviewed) | **Pre-moderation in v1**, consistent with D-14                                                |
| N-04 | Who may publish for a business                        | Owners and Admins through a new business permission, business-wide only            | **Yes**; mirrors D-02. Branch-scoped users cannot publish                                     |
| N-05 | Plan gating for ordinary posts                        | None, or by plan                                                                   | **None for ordinary posts**; premium promotion and B2B only, later. Final rule waits for D-24 |
| N-06 | Eligibility to publish                                | Any business, or only a business with a live published BDPN profile                | **Live published profile required**                                                           |
| N-07 | v1 content format                                     | Text only; limits (length, one https link)                                         | **Plain text, bounded length, at most one https link**                                        |
| N-08 | What a business learns about followers                | Nothing, a count, or identities                                                    | **A count only**; never identities in v1                                                      |
| N-09 | Official Echo Grid posts                              | Platform admin authors; second platform admin approves                             | **Two-person rule**                                                                           |
| N-10 | Feed content scope                                    | All approved posts, or followed businesses plus official                           | **All approved posts plus a "Following" filter**, reverse-chronological                       |
| N-11 | Retention and deletion                                | Soft delete with audit; legal retention period                                     | **Soft delete; retention period needs counsel**                                               |
| N-12 | Reporting                                             | Who may report; limits                                                             | **Any signed-in customer and any business user**; rate-limited                                |
| N-13 | Sponsored and paid placement                          | In this record or later                                                            | **Excluded**. Not in any schema until its own approved block                                  |
| N-14 | Analytics                                             | None, explicit-action counts, reach                                                | **None in v1** (D-17). Revisit with a privacy review                                          |
| N-15 | Minimum customer age and eligibility for user content | Unknown                                                                            | **Blocks customer-created content** until decided                                             |
| N-16 | Language                                              | Per-post content language, no auto-translation                                     | **Per-post `contentLocale`; no auto-translation in v1**                                       |
| N-17 | Feed namespace versus customer UI placement           | Separate API/storage names and optionally nested customer UI route                 | **Reserve `network` for API/storage; customer UI may be nested below `/community`**            |

## 8. What this record does not claim

- No part of the network is built. Public copy must not describe a feed, posts, follows or a business network until each is implemented, verified and released and the owner approves the wording.
- No legal conclusion is offered. Jurisdiction-specific requirements need qualified counsel (see the moderation companion).

## 9. Acceptance and change control

- Approval means: the owner marks this record approved (all N-xx either decided or explicitly deferred) in a short decision record, as was done for BDPN.
- Each NETWORK block then needs its own authorization, reconciliation with the latest `main`, threat and consent review, tests, exact-head CI, and an owner completion report.
- **Stop conditions:** a missing approval, an unresolved D-24 where a plan rule is needed, an unwritten content policy, or an unstaffed moderation queue stops the block.
- **CURRENT NO-GO** (unchanged): outbound marketing, automatic business-join broadcasts, customer-list extraction, Partner Credit or Stripe effects, advertising activation, production configuration changes, and any migration without separate authorization.
