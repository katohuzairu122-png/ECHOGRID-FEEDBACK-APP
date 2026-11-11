# BDPN-01 — Implementation Sequence, Migration Plan and Decision Register

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY. None of the blocks below is authorized or started.
No block auto-advances, auto-merges or auto-deploys. Each requires explicit owner authorization after review.**

- Baseline: `origin/main` @ `443739e95ef0b993647f31ff8c529ef44eb1b72e`
- Companions: `BDPN_01_BUSINESS_PROFILE_DISCOVERY_SPEC.md`, `BDPN_01_SECURITY_AND_CONSENT_BOUNDARIES.md`
- Locked inputs: BDPN v1.0 roadmap (BDPN-01 to 06), `SPLIT09_BDPN_RECONCILIATION.md`.

## 1. Dependency overview

```text
Owner decisions (section 5)
        |
        v
BDPN-01A  data contracts + schema proposal  ->  BDPN-01B  validation + moderation authority
        \                                          |
         \--------------------------------------> BDPN-01C  discovery API design
                                                    |
                                                    v
                                           BDPN-01D  Community Hub integration design
                                                    |
                                                    v
                                           BDPN-01E  security, migration, release verification plan
                                                    |
                                                    v
                         (only then, separately authorized)  implementation blocks
```

The five BDPN-01 sub-blocks are **design blocks** (documents and contracts only). Implementation is a **separate,
later authorization** and would reuse these contracts. The sub-blocks are independently executable once their
listed decisions are answered; 01A is the prerequisite for the others.

## 2. Sub-block definitions

### BDPN-01A — Publication data contracts and schema proposal

| Item                                             | Content                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Goal                                             | Freeze the field contract, the revision/publication data model, constraints and the exact migration list.                                                                                                                                                                      |
| Depends on                                       | D-01, D-04, D-05, D-06, D-07, D-08, D-10, D-19                                                                                                                                                                                                                                 |
| Boundary                                         | Documents and shared-type **proposals** only. No migration file, no schema code, no journal change.                                                                                                                                                                            |
| Deliverables                                     | Final entity list and column-level contract; constraint list (checks, composite FKs, immutability guard, partial unique index); handle generation rule; translation rules; migration count and ordering; the Gate 2 re-pin impact list regenerated from the then-current main. |
| Test requirements (to be specified, not written) | Schema constraint test list; immutability and composite-FK negative tests; round-trip of translations; migration replay plan.                                                                                                                                                  |
| Owner gate                                       | Approval of the entity list and of the migration batching (D-19) before 01E.                                                                                                                                                                                                   |
| Acceptance                                       | Every field in the spec 2.2 is either mapped to storage or explicitly deferred; no existing table is altered; no synthetic field exists; the contract reviewed against Splits 01, 02, 05, 07, 08.                                                                              |

### BDPN-01B — Business profile validation and moderation authority design

| Item                          | Content                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal                          | Freeze validation rules, the transition service contract, the permission keys and the moderation workflow.                                                                                                                                                                                                                                  |
| Depends on                    | 01A; D-02, D-03, D-04, D-13, D-14, D-15, D-16, D-21                                                                                                                                                                                                                                                                                         |
| Boundary                      | Design only. No permission seeded, no role changed, no route created.                                                                                                                                                                                                                                                                       |
| Deliverables                  | Field validation tables (length, charset, normalization, URL/phone/email rules); transition service contract (inputs, preconditions, errors, idempotency); permission key list and the role-to-permission map; moderation queue and reason-code taxonomy; separation-of-duties and impersonation rules; audit action and metadata contract. |
| Test requirements (specified) | Per-transition legal and illegal cases; self-approval refusal; impersonation denial; digest-mismatch abort; concurrency matrix.                                                                                                                                                                                                             |
| Owner gate                    | Approval of moderator roles, reason codes, SLA and content policy (D-03, D-15, D-16). Legal review where required.                                                                                                                                                                                                                          |
| Acceptance                    | Every transition in the spec 3.2 has actor, preconditions, error behavior and audit evidence; no business-side path can publish.                                                                                                                                                                                                            |

### BDPN-01C — Published-business discovery API design

| Item                          | Content                                                                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal                          | Freeze the discovery endpoints, DTOs, query semantics, caching and abuse controls.                                                                                                                                            |
| Depends on                    | 01A, 01B; D-09, D-10, D-11, D-12, D-17, D-25                                                                                                                                                                                  |
| Boundary                      | Design only. No endpoint is implemented. `GET /businesses/:id/public` is not modified.                                                                                                                                        |
| Deliverables                  | Endpoint and error contract; closed DTO allow-lists; search and index strategy; cursor format; rate-limit design (limiter, key, limits); caching and epoch design; uniform not-found behavior; multilingual resolution rules. |
| Test requirements (specified) | DTO key-set contract tests; equality test across different customers (no personalization); enumeration and rate-limit tests; header tests; withdrawn-profile-unreachable test.                                                |
| Owner gate                    | Anonymous vs authenticated access and identifier exposure (D-09, D-10); caching policy (D-12).                                                                                                                                |
| Acceptance                    | The discovery contract can be implemented without reading any private table; it passes the T-01, T-08, T-10, T-15, T-16, T-17 reviews on paper.                                                                               |

### BDPN-01D — Community Hub integration design

| Item                          | Content                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal                          | Freeze the customer experience: routes, states, entry from H1, language and accessibility, and non-effects.                                                                                                               |
| Depends on                    | 01C; D-18, D-20                                                                                                                                                                                                           |
| Boundary                      | Design only. No page or component is built. H1 and H2 behavior is unchanged.                                                                                                                                              |
| Deliverables                  | Route and navigation map; the list, filter, search, detail, empty, no-match, forbidden and unavailable states; the Hub entry card; locale and RTL behavior; mobile layout; the explicit non-effects checklist (spec 5.3). |
| Test requirements (specified) | Component state tests; accessibility checks; a browser test plan asserting that browsing creates no membership, account, consent, notification or points.                                                                 |
| Owner gate                    | "How to join" wording and whether any join affordance appears on a profile (D-18).                                                                                                                                        |
| Acceptance                    | Every state is specified; discovery needs no Community membership; H1 and H2 are untouched; no new top-level navigation item.                                                                                             |

### BDPN-01E — Security, migration and release verification plan

| Item                          | Content                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal                          | Freeze the verification and release plan for the eventual implementation, including the Gate 2 handling.                                                                                                                                                             |
| Depends on                    | 01A to 01D; D-19, D-20, D-24                                                                                                                                                                                                                                         |
| Boundary                      | Design only. No migration is created or applied; no deployment.                                                                                                                                                                                                      |
| Deliverables                  | Consolidated threat-to-test matrix from the Security document; non-owner role, RLS and grants plan for the new tables; migration replay and Gate 2 re-pin procedure; activation-flag and rollout plan; rollback plan; evidence list for the owner completion report. |
| Test requirements (specified) | The test catalogue of the Security document section 7, mapped to CI jobs.                                                                                                                                                                                            |
| Owner gate                    | Migration batching and the staging backlog (D-19); activation approach (D-20).                                                                                                                                                                                       |
| Acceptance                    | The plan lets an independent reviewer verify tenant isolation, consent boundaries and fail-closed behavior from CI evidence alone.                                                                                                                                   |

## 3. Migration dependencies and Gate 2 implications (documentation only)

| Topic                    | Fact on baseline / proposal                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current chain            | 68 migrations, last `0067_customer_preferred_locale`; merged, **not applied** to staging or production. Staging is at 45 (23 pending).                                                                                                                                                                                              |
| Proposed BDPN-01 schema  | 5 new additive tables (spec section 7): `business_public_profiles`, `business_profile_revisions`, `..._translations`, `..._media`, `..._locations`. No existing table is altered.                                                                                                                                                   |
| Proposed batching        | **One** migration file for the BDPN-01 schema (recommended, D-19) so Gate 2 is re-pinned once (68 → 69). Splitting into several migrations multiplies re-pins.                                                                                                                                                                      |
| Re-pin scope             | Gate 2 scripts, three workflows and release tests hard-pin the journal length and last tag (18 files matched on this baseline). The list must be **regenerated by search at implementation time**, not copied from this document. CI job `name:` values must stay unchanged so required-check names do not move (as done for 0067). |
| Preflight                | `staging-migration-preflight` expectations (expected count, pending count and last tag) change with each migration.                                                                                                                                                                                                                 |
| Backlog ordering         | BDPN-01 schema would extend the unapplied staging backlog; the owner decides whether the backlog is authorized first, or together (D-19). Nothing here applies any migration.                                                                                                                                                       |
| Roles and RLS            | New tenant-owned tables need grants and policies consistent with the existing non-owner and restricted-role contract; moderation write paths need an explicit, audited grant. To be designed in 01E and proven on disposable PostgreSQL 18.                                                                                         |
| Rollback                 | Additive tables; rollback is "stop reading and drop the new tables"; no data in existing domains changes.                                                                                                                                                                                                                           |
| Data seeding             | No profile row is ever auto-created at business registration (R3). Existing businesses start `unpublished`.                                                                                                                                                                                                                         |
| Customer language column | Unrelated to BDPN; not a promotional preference and not used for consent.                                                                                                                                                                                                                                                           |

## 4. Release verification plan (outline for 01E)

1. Implementation lands as separate, owner-authorized PRs per block, each with exact-head hosted CI reported as actually run.
2. Discovery ships **behind an activation flag, off by default** (D-20); the Community Hub entry card appears only when on.
3. Disposable PostgreSQL 18 replay of all migrations from scratch and from the current head; forced RLS and non-owner
   denial suites extended to the new tables.
4. Browser verification with real fixtures: publish, update-while-live (old content stays), withdraw (unreachable on
   next request), suspend, business-status change, and the non-effects checklist.
5. Owner completion report listing evidence per threat in the Security document.
6. Any deployment, migration application or activation is a **separate explicit owner authorization**.

## 5. Decision register (all OPEN — none is decided by this document)

"Recommendation" is the author's proposal for the owner's consideration, not a decision. Where the item is a
product, legal or economic policy, no recommendation is made.

| ID   | Decision needed                                                                | Options                                                                                            | Recommendation                                                               | Blocks   |
| ---- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| D-01 | Profile data model                                                             | (a) immutable revisions + publication pointer; (b) single row with a pending-copy column set       | (a), for approve-then-edit safety and audit                                  | 01A      |
| D-02 | Which business roles may edit and submit; permission key names                 | New keys `profile:edit`, `profile:submit` to Owner/Admin only; or reuse `business:manage_settings` | New keys, business-wide only                                                 | 01B      |
| D-03 | Which platform roles moderate; whether suspension needs two people             | `admin` only; `admin`+`support`; with or without two-person rule                                   | Moderation by an explicit code-owned permission; role set is a policy choice | 01B      |
| D-04 | Minimum fields required to submit                                              | Name only; name + summary + category; name + description + category + one contact                  | Not recommended without product input                                        | 01A, 01B |
| D-05 | Media in v1                                                                    | None; logo only; logo + gallery                                                                    | None or logo only, behind a separate upload threat review                    | 01A, 01B |
| D-06 | Public location detail                                                         | City/country only; opted-in street address; service area only                                      | City/country plus opt-in address; never coordinates                          | 01A      |
| D-07 | Public contact fields and verification                                         | Website only; website + phone + email; any verification (domain/phone)                             | Policy and legal input needed                                                | 01A, 01B |
| D-08 | Approved subcategories                                                         | Defer; platform tag catalog                                                                        | Defer (no taxonomy exists)                                                   | 01A      |
| D-09 | Anonymous vs authenticated discovery                                           | Authenticated customers only; also anonymous read                                                  | Authenticated only in v1 (enumeration and privacy)                           | 01C      |
| D-10 | Public identifier                                                              | Opaque `profile_handle`; business slug; `businesses.id`                                            | Opaque handle; do not expose `businesses.id`                                 | 01A, 01C |
| D-11 | Category name localization source and search language handling                 | Catalog names with translations; keys only                                                         | Needs a catalog translation decision                                         | 01C      |
| D-12 | Caching                                                                        | `no-store` only; short TTL keyed to a publication epoch; signed-media URL lifetime                 | `no-store` for v1; revisit with data                                         | 01C, 01E |
| D-13 | Re-publish after withdrawal                                                    | Immediate if unchanged and eligible; full re-review                                                | Policy decision                                                              | 01B      |
| D-14 | Update review scope                                                            | Every edit reviewed; only material edits                                                           | Every edit (a "trivial" classifier is itself a policy)                       | 01B      |
| D-15 | Moderation SLA, reason-code taxonomy, appeal path                              | —                                                                                                  | Policy decision                                                              | 01B      |
| D-16 | Content policy and jurisdictional/legal review                                 | —                                                                                                  | Legal/owner decision                                                         | 01B      |
| D-17 | Analytics or impression tracking                                               | None; aggregate-only counts; thresholds                                                            | None in v1                                                                   | 01C      |
| D-18 | "How to join" text or any join affordance on a profile                         | None; informational text only; deep link to QR flow explanation                                    | Informational text only; never a join action                                 | 01D      |
| D-19 | Migration batching and the staging backlog                                     | One batched migration vs several; authorize the 23 pending first vs together                       | One batched migration; backlog ordering is the owner's                       | 01A, 01E |
| D-20 | Activation and rollout                                                         | Flag off by default; internal-only first; staged                                                   | Off by default, internal first                                               | 01D, 01E |
| D-21 | Business identity verification before publication                              | None; manual platform check; external verification                                                 | Policy and legal decision                                                    | 01B      |
| D-22 | What moderators can see of private business data during review                 | Public fields only; plus internal ids                                                              | Public fields plus minimum needed                                            | 01B      |
| D-23 | Whether Split 09 may require "currently discoverable" as an eligibility rule   | Yes via the eligibility predicate; no                                                              | Decide when Split 09 is specified                                            | Split 09 |
| D-24 | Whether publication is a subscription-plan feature                             | Free for all; plan-gated                                                                           | **Not recommended: economic policy, owner only**                             | 01E      |
| D-25 | Hardening of the existing `GET /businesses/:id/public` (not publication-gated) | Leave unchanged; narrow to businesses with a QR context; gate by status                            | Separate hardening decision; BDPN-01 leaves it unchanged                     | 01C      |

## 6. Required review checkpoints before any implementation is authorized

1. Owner answers to the decisions listed under each block's "Depends on".
2. A fresh reconciliation against the then-current `origin/main` and any decisions made in the interim.
3. Confirmation that no proposed capability bypasses customer consent or tenant isolation (Security document sections 1, 4, 5).
4. Explicit authorization of the single next block; **no block starts automatically**.
