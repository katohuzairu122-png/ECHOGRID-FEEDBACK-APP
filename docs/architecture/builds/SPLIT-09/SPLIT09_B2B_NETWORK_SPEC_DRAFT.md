# Split 09 — B2B Business Network: draft specification (for owner review)

**Status: DRAFT PROPOSAL — DOCUMENTATION ONLY. Nothing here is approved, and nothing here authorizes any code, schema, migration, endpoint, UI, notification, marketing, settlement, merge or deployment.**
Every policy statement below is a *proposal* with options and a recommendation. Where the repository has no owner decision, this document says so and lists it in section 12 instead of deciding it.

- Baseline: `origin/main` @ `4fd02f87048997874b4d5edd7e6d04cc66560d4d` (migration journal 80, last `0079`).
- Author: Claude Code (B2B workstream). Reviewer: repository owner.
- Supersedes nothing. Builds on `SPLIT09_BDPN_RECONCILIATION.md` (D-A to D-F), `docs/B2B-SCOPE-RECONCILIATION-2026-11-17.md`, `BDPN_01_*`, `NETWORK_00_*`, Splits 01-08.
- Not in scope for this workstream: Community Feed, platform moderation, moderation history and customer Community interfaces (owned by the Community workstream).

## 1. Purpose

Split 09 is the deferred B2B architecture named by Split 02: an Echo Grid-controlled space where **businesses** find, describe themselves to, and form relationships with **other businesses**. It is the missing specification that blocks partnership requests, lifecycle, partner authorization and cross-business interaction APIs (scope items 3 to 7 of the B2B brief).

It is **not** BDPN (customer-facing discovery and opt-in promotion), not the Community Feed, and not any financial or settlement system.

## 2. Locked inputs this draft must respect

1. **Owner definition (D3):** an Echo Grid-controlled business networking and collaboration system with *separate capabilities and separate ledgers*; no direct business-to-business editing of private customer records, loyalty balances or financial accounts. The Platform Admin Console is not the B2B platform.
2. **Ledger separation:** business loyalty, Community Points, orphan claims, Partner Credits and billing remain separate. Split 09 adds **no** ledger and touches none.
3. **Storage separation:** B2B content lives in **separate storage** from the Community feed (`NETWORK_00_CONTENT_MODEL_AND_ACCESS.md`: `b2b_listing` / `b2b_thread` are "Split 09, never in the feed tables").
4. **Customer privacy and consent:** discovery is not consent; no customer data, customer count, ranking by customers or customer list crosses a business boundary (BDPN security section 1).
5. **Platform decides publication; business decides content** (BDPN principle 4). Fail closed on any missing or ambiguous fact.
6. **Tenant isolation and RBAC** unchanged; platform authority uses the code-owned platform-permission pattern; impersonation is read-only for authoring and approval actions.
7. **Financial activation is NO-GO.** No settlement, advertising, sponsored placement or cross-business customer targeting without explicit owner approval.
8. **NETWORK-04 (B2B) is gated on a Split 09 specification** (`NETWORK_00_PHASING_THREATS_AND_TESTS.md`), with separate tables, separate permissions and no feed exposure.

## 3. Scope

**In (proposed):**
- B2B network identity and listings: how an enrolled business describes the resources and services it offers to other businesses.
- B2B directory: how enrolled businesses discover each other's listings.
- Partnership requests: one business asks another to partner; the other accepts or declines.
- Partnership lifecycle: active, suspended, terminated, with who may do what.
- Partner authorization: what an active partnership permits (v1 proposal: very little, see section 6).
- B2B management UI and in-app notifications for the above.
- Audit records and security controls for all of it.

**Out (each needs its own specification and approval):**
- Any money, credit, reward, points, settlement or billing effect, including Partner Credits visibility (blocked behind the Split 08 freeze).
- Community Point redemption partnerships, orphan-settlement collaboration changes, cross-business survey research, offers and business campaigns, marketing-priority services.
- Anything that shares or infers customer data between businesses.
- Outbound email, SMS or push.

## 4. Conceptual model (not a schema)

Names are placeholders; real tables, columns and migrations belong to an implementation block after approval.

| Concept | Meaning | Key rules (proposed) |
| --- | --- | --- |
| **B2B participation** | A business is enrolled in the B2B network | Platform-recorded, business-accepted (mirrors Split 07 enrollment); revocable by the platform |
| **B2B listing** | A business's description of its offered resources and services | Immutable revisions plus a live pointer (as BDPN D-01); every revision reviewed before it goes live (as D-14); text only, no media in v1 |
| **Partnership** | A relationship between exactly two enrolled businesses | Unordered pair; at most one non-terminal partnership per pair; both businesses referenced by `business_id`, never by name |
| **Partnership event** | Every state change | Append-only, with actor, role, timestamp and reason; never updated or deleted |
| **B2B thread / message** *(optional, see S9-D7)* | Business-to-business conversation tied to a partnership or request | Separate from customer conversations; never reachable from customer routes |

Entity ownership: each row belongs to one or two businesses and is only readable by them, by platform staff with the relevant permission, and (for published listings) by other enrolled businesses.

## 5. Proposed state machines

**Partnership (proposal):**

```
requested --accept(counterparty)--> active
requested --decline(counterparty)--> declined (terminal)
requested --withdraw(requester)----> withdrawn (terminal)
requested --expire(system)---------> expired (terminal)
active ----suspend(platform)-------> suspended
suspended -lift(platform)----------> active
active|suspended --terminate(either business or platform)--> terminated (terminal)
```

Rules: a terminal partnership never reopens (a new request is a new partnership); every transition writes a partnership event; the counterparty, never the requester, accepts; a platform actor can suspend or terminate but cannot accept on a business's behalf; impersonating sessions can do none of these.

**Listing:** `draft -> submitted -> approved | rejected`; `approved -> withdrawn`; `approved -> suspended` (platform). Edits create a new revision and require review (as BDPN D-13/D-14).

## 6. What a partnership grants

**Proposal for v1: mutual visibility and a message channel only.** An active partnership allows the two businesses to (a) see each other as partners in the B2B area and (b) exchange messages if S9-D7 approves threads. It grants **no** access to customers, loyalty data, feedback, analytics, surveys, points, credits or billing, and has **no** automatic financial or reward effect. Any richer capability (referrals, co-offers, shared campaigns, shared research) needs its own specification, owner approval and Gate 2 plan.

## 7. Authorization (proposed)

Permission keys are proposals, added to the business-scoped catalog and a code-owned platform permission.

| Actor | View own listing/partnerships | Edit/submit listing | Request / accept / decline / terminate | Browse directory | Moderate listings | Suspend / lift / terminate any |
| --- | --- | --- | --- | --- | --- | --- |
| Business owner/admin with `b2b:manage` (business-wide) | Yes | Yes | Yes | Yes | No | No |
| Business user with `b2b:view` only | Yes | No | No | Yes | No | No |
| Branch-scoped user / cashier | No | No | No | No | No | No |
| Platform moderator (`b2b:moderate`, role set per S9-D10) | Any | No (cannot author) | No | n/a | Yes (not own submissions) | Yes |
| Platform support (read only, if granted) | Read | No | No | n/a | No | No |
| Impersonating session | Read only | No | No | Read only | No | No |
| Customer, anonymous visitor | No | No | No | **No** | No | No |

Authorization is re-resolved from the database on every request. Every B2B route requires an enrolled, active business context. A business can only act as itself.

## 8. Privacy and consent boundaries

- **No customer data crosses.** No endpoint, count, ranking, export or message template exposes or infers another business's customers, loyalty configuration or feedback.
- **Customers never see the B2B area.** B2B routes are not reachable with a customer session and appear nowhere in customer navigation or the Community feed.
- **Directory minimization:** a listing exposes only approved fields; internal ids stay internal; the public-by-id `GET /businesses/:id/public` is never used as proof of enrollment or publication (BDPN D-25).
- **No tracking** of who viewed a listing in v1 (parallel to BDPN D-17).
- **What platform staff may read in threads** is an owner privacy decision (S9-D7), not assumed here.

## 9. Security controls and audit

- Fail closed on unknown, suspended or not-enrolled businesses.
- Append-only partnership events and immutable listing revisions, protected by database guards in the same style as existing evidence tables; no delete path.
- Rate limits and per-pair, per-day caps on partnership requests and messages; no request to a business that has declined within a cooling-off window (value is an owner decision, S9-D3).
- Anti-enumeration: the directory is paginated, no-store, and never reveals non-enrolled or non-published businesses; unknown ids and foreign-tenant ids return the same response.
- Abuse reporting and platform suspension (S9-D10); content policy follows BDPN D-16 once approved.
- Every route carries authorization, regression and cross-tenant denial tests (see section 13).

## 10. Proposed API surface (names only, not implemented)

Namespace `/b2b/...`, distinct from `/community/...`, `/network/...` and customer routes.

```
GET    /b2b/participation                 own enrollment state
POST   /b2b/participation/accept          accept published B2B terms (explicit owner approval to enable)
GET    /b2b/listing                       own listing + revision state
PUT    /b2b/listing                       edit draft revision
POST   /b2b/listing/submit | /withdraw
GET    /b2b/directory                     enrolled, approved listings only (paginated)
GET    /b2b/directory/:handle             one listing (opaque handle)
POST   /b2b/partnerships                  request (target by handle)
GET    /b2b/partnerships                  own, by state
POST   /b2b/partnerships/:id/accept | decline | withdraw | terminate
GET    /platform/b2b/review-queue         platform moderation (platform permission)
POST   /platform/b2b/listings/:id/approve | reject | suspend | lift
POST   /platform/b2b/partnerships/:id/suspend | lift | terminate
```

## 11. Notifications

Proposal: **in-app only** for the businesses involved (request received, accepted, declined, terminated, listing reviewed). No email, SMS or push in v1; any outbound channel needs its own consent and approval gate (BDPN-02). No promotional event type is added.

## 12. Open owner decisions (nothing here is decided)

| ID | Question | Options | Recommendation |
| --- | --- | --- | --- |
| S9-D1 **(DECIDED, 12A)** | Who may participate? | (a) all active published businesses; (b) only businesses the platform enrolls and that accept B2B terms | (b), consistent with the 2026-11-12 workspace proposal and Split 07 enrollment |
| S9-D2 **(DECIDED, 12A)** | One profile entity or two (BDPN D-A) | one shared entity owned by BDPN-01 with B2B capability sections; or a separate B2B listing entity | One entity, so publication and moderation exist once. Split 09 listing then depends on the BDPN profile foundation |
| S9-D3 | Request limits | cooling-off after a decline, per-day request cap, request expiry | Owner picks the numbers; Claude proposes none |
| S9-D4 | Who approves a partnership? | counterparty only; or counterparty plus platform | Counterparty only; platform may suspend or terminate |
| S9-D5 | What does a partnership grant? | visibility + messages only (this draft); or richer capabilities | Visibility and messages only in v1; richer capability needs its own spec |
| S9-D6 | Termination effects and retention | immediate unilateral termination; how long threads and events are retained | Immediate unilateral; retention period is an owner/legal decision |
| S9-D7 | B2B messaging in v1? | none; or threads tied to a request/partnership | Defer threads until content policy and staff-access rules are decided; ship listings and partnership state first |
| S9-D8 **(DECIDED, 12A)** | Listing content shape | structured categories; or free text; no media in v1 | Structured category plus short free text, no media (parallels D-04/D-05) |
| S9-D9 | Notifications | in-app only | In-app only |
| S9-D10 | Moderation roles and suspension | which platform roles moderate; two-person rule for suspension | Platform admins only; support read-only, as BDPN D-03 |
| S9-D11 | Plan gating of B2B | universal vs plan-gated | Do not decide here; blocked with OD-1/D-24 and OD-14 (entitlements). Until then the model stays ungated |
| S9-D12 **(DECIDED, 12A; conditional on the final BDPN migration ruling)** | Migration shape | one Split 09 migration (D-19) vs per-block (OD-24) | Follow whichever the owner approves for BDPN so the two do not diverge |
| S9-D13 | Cross-business research and any shared data | out of scope | Out until its own specification |

## 12A. Owner rulings (2026-11-18) — CONFIRMED BY THE OWNER

Received from the owner as "ECHO GRID — SPLIT 09 OWNER RULINGS (PROPOSED)", scope S9-D1, S9-D2, S9-D8, S9-D12, and **confirmed by the owner on 2026-11-18** ("Confirm the four rulings"). They are recorded verbatim below. These four are now **DECIDED**. All other decisions in section 12 remain open.

| ID | Ruling (verbatim) | Status |
| --- | --- | --- |
| S9-D1 | B2B participation requires explicit platform enrollment and acceptance of B2B terms. Publishing a business profile alone does not confer B2B participation. | DECIDED |
| S9-D2 | BDPN-01 owns the single authoritative business profile entity. Split 09 extends that entity with B2B capabilities rather than creating a duplicate listing entity. | DECIDED |
| S9-D8 | B2B v1 listings support structured categories and a short free-text description. No media uploads. Reuse the approved BDPN taxonomy and content restrictions where applicable. | DECIDED |
| S9-D12 | Prefer independently versioned, per-block migrations, subject to reconciliation with the final BDPN migration ruling. No migration execution is authorized. | DECIDED, with the stated condition: subject to reconciliation with the final BDPN migration ruling |

Restrictions that came with the rulings (still in force): no B2B feature activation, deployment, migration execution or automatic PR merge is authorized.

**Consistency notes (nothing here changes a ruling):**

- **S9-D1** matches the section 12 recommendation (option b). Enrollment follows the Split 07 pattern: platform-recorded, business-accepted, revocable by the platform. A published BDPN profile is necessary context but never sufficient for B2B participation.
- **S9-D2** matches the section 12 recommendation. Consequence: Split 09 listing work cannot start before the BDPN profile foundation exists, and the foundation is still gated by OD-1/D-24, OD-14 and D-16 (see `BDPN_PREREQUISITE_MATRIX_2026-11-16.md`). The B2B capability sections would extend the BDPN profile revision model (immutable revisions plus a live pointer, D-01), so they inherit its review-before-live rule (D-14).
- **S9-D8** matches the recommendation. "Approved BDPN taxonomy and content restrictions" resolves to: category names from the platform category catalog with translated names (D-11), no subcategories (D-08), no media (D-05), and the BDPN content policy. **The content policy (D-16) is still an unapproved interim draft**, so "content restrictions" has no approved text yet. The short free-text length limit is not specified by the ruling and remains to be set.
- **S9-D12** prefers per-block migrations. This is the shape proposed by BDPN **OD-24**, which is **not yet approved**, while the decided BDPN rule is **D-19** (apply the backlog, then ship BDPN as one new migration). The ruling already defers to "the final BDPN migration ruling", so the conflict resolves when OD-24 versus D-19 is decided. Until then Split 09 should assume neither and write no migration.

**Effect on phasing (section 13):** S9-A is now scoped as "extend the BDPN profile entity with a B2B participation record and B2B capability sections", still blocked on the BDPN profile foundation. No block in section 13 is authorized to start.

## 13. Proposed phasing and acceptance (each a separate authorization)

| Block | Delivers | Needs first |
| --- | --- | --- |
| S9-A | B2B participation, listing revisions and moderation (reuses BDPN profile foundation if S9-D2 = one entity) | BDPN profile foundation; S9-D1, D2, D8, D10, D12 |
| S9-B | Directory read model and UI | S9-A in staging; D11 |
| S9-C | Partnership requests, accept/decline/withdraw, events, in-app notifications | S9-A; D3, D4 |
| S9-D | Lifecycle: suspend, terminate, retention | S9-C; D6 |
| S9-E | Messaging | D7 and the content policy |

Acceptance tests every block must carry: cross-tenant denial for every route; unknown, unenrolled and suspended business fails closed; customer sessions get no B2B access; impersonation cannot author or approve; append-only guards reject update/delete; separation of duties (approver is not the submitter); no ledger, loyalty, points, credit or billing row changes; rate limits and per-pair caps; terminal partnerships cannot reopen; directory never leaks non-enrolled businesses; every state change leaves an audit event.

## 14. Risks, assumptions, future work

- **Assumption:** the BDPN profile foundation is built first, or S9-D2 chooses a separate entity; neither is decided.
- **Risk:** spam and harassment between businesses; mitigated by enrollment gating, caps, cooling-off, reporting and platform suspension (numbers owner-set).
- **Risk:** B2B messaging creates a new privacy surface; hence deferred (S9-D7).
- **Future work (separate specs):** referrals and co-offers, cross-business research, Community Point redemption partnerships, Partner Credit visibility after the Split 08 freeze, marketing priority.

## 15. Changelog

- 2026-11-18: first draft by Claude Code for owner review. No decision recorded.
- 2026-11-18: recorded the owner's proposed rulings for S9-D1, S9-D2, S9-D8 and S9-D12 in section 12A, marked awaiting owner confirmation. All other decisions remain open.
- 2026-11-18: owner confirmed the four rulings. S9-D1, S9-D2, S9-D8 and S9-D12 are DECIDED (S9-D12 conditional on the final BDPN migration ruling). The nine other decisions (S9-D3 to S9-D7, S9-D9 to S9-D11, S9-D13) remain open. No implementation is authorized.
