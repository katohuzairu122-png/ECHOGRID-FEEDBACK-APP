# BDPN-01 — Owner Decision Record

**Status: DECISION RECORD — DOCUMENTATION ONLY. Records owner answers to the BDPN-01 decision register. Nothing here
implements anything, authorizes a migration, endpoint, page, notification, marketing, merge or deployment.**

- Baseline: `origin/main` @ `f0989202` (includes merged #362, which contains the register).
- Source: the owner's answers to the register in a working session on 2026-11-11, given one question at a time with
  the author's recommendation shown first. Where the owner chose a different option from the recommendation, this is
  stated explicitly.
- Relationship to existing documents: this record **updates the status** of the 25 items in the register in
  `BDPN_01_IMPLEMENTATION_SEQUENCE.md` section 5. It does not rewrite the specification or the security document;
  section 3 lists the changes they will need. No locked decision (BDPN v1.0, Splits 01–09) is contradicted.
- Status values: **DECIDED**; **DECIDED, follow-up open** (a related question remains); **DEFERRED** (intentionally
  not decided now).

## 1. Decisions

| ID   | Topic                               | Owner decision                                                                                                               | Status                  | Note                                                                                                                                                                       |
| ---- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | Data model                          | Immutable revisions plus a live pointer                                                                                      | DECIDED                 | As recommended                                                                                                                                                             |
| D-02 | Who edits and submits               | Owners and Admins, through new profile permissions (edit, submit), business-wide only                                        | DECIDED                 | As recommended                                                                                                                                                             |
| D-03 | Platform moderators                 | Platform admins only, through a separate code-owned moderation permission                                                    | DECIDED                 | As recommended. Support may not moderate.                                                                                                                                  |
| D-04 | Minimum to submit                   | Display name, summary, description, category **and at least one location or service area**                                   | DECIDED                 | **Differs from the recommendation** (a smaller set). Fuller profiles required.                                                                                             |
| D-05 | Media in v1                         | No images in v1                                                                                                              | DECIDED                 | As recommended. Logo upload is a later, separately reviewed block.                                                                                                         |
| D-06 | Location detail                     | City and country, plus an optional street address the business chooses to show; never coordinates; service-area-only allowed | DECIDED                 | As recommended                                                                                                                                                             |
| D-07 | Public contact                      | Website only (https) in v1                                                                                                   | DECIDED                 | As recommended. No public phone or email in v1.                                                                                                                            |
| D-08 | Subcategories                       | Not in v1                                                                                                                    | DECIDED                 | As recommended                                                                                                                                                             |
| D-09 | Who can browse                      | Signed-in customers only                                                                                                     | DECIDED                 | As recommended                                                                                                                                                             |
| D-10 | Identifier                          | New opaque random handle; internal business id never exposed in discovery                                                    | DECIDED                 | As recommended                                                                                                                                                             |
| D-11 | Category names                      | Add translated names to the platform category list                                                                           | DECIDED                 | As recommended. Needs a small content task for `en, fr, es, ar`.                                                                                                           |
| D-12 | Caching                             | None in v1: `private, no-store` on every discovery response                                                                  | DECIDED                 | As recommended                                                                                                                                                             |
| D-13 | Re-publish after withdrawal         | Live again immediately if unchanged and still eligible                                                                       | DECIDED                 | Any change goes through review (D-14).                                                                                                                                     |
| D-14 | Edit review                         | Every edit is reviewed before it goes live                                                                                   | DECIDED                 | As recommended                                                                                                                                                             |
| D-15 | Moderation SLA and appeal           | No promised timeframe in v1; rejection shows a clear reason; resubmission is the appeal path                                 | DECIDED                 | As recommended                                                                                                                                                             |
| D-16 | Content policy and legal review     | The author drafts an interim policy for owner review                                                                         | DECIDED, follow-up open | The draft is in `BDPN_01_INTERIM_CONTENT_POLICY_DRAFT.md`. It is **not legal advice** and is not in force until the owner (and counsel, if the owner chooses) approves it. |
| D-17 | View tracking                       | None in v1                                                                                                                   | DECIDED                 | As recommended                                                                                                                                                             |
| D-18 | Join wording                        | Informational text only; no join button                                                                                      | DECIDED                 | As recommended                                                                                                                                                             |
| D-19 | Migration handling                  | Apply the existing backlog first, then ship BDPN as one new migration                                                        | DECIDED                 | Requires a written backlog plan and separate authorization for every environment step (section 4).                                                                         |
| D-20 | Rollout                             | Off by default, internal testing first, then everyone                                                                        | DECIDED                 | As recommended. Controlled by an activation switch.                                                                                                                        |
| D-21 | Identity verification               | Manual platform review only for v1                                                                                           | DECIDED                 | As recommended                                                                                                                                                             |
| D-22 | What moderators see                 | The submitted profile **plus the business's team and subscription details**                                                  | DECIDED                 | **Differs from the recommendation.** Safeguards in section 2.                                                                                                              |
| D-23 | Split 09 reliance on "discoverable" | Not decided; revisit when Split 09 is specified                                                                              | DEFERRED                |                                                                                                                                                                            |
| D-24 | Plan gating                         | Publication should be available **only on certain plans**                                                                    | DECIDED, follow-up open | **Which plans, and how entitlement is checked, is not decided.** It is economic policy (section 2).                                                                        |
| D-25 | Existing `/businesses/:id/public`   | Leave unchanged for now                                                                                                      | DECIDED                 | As recommended. Hardening is a possible separate block.                                                                                                                    |

Counts: 22 DECIDED, 2 DECIDED with a follow-up open (D-16, D-24), 1 DEFERRED (D-23). Two decisions differ from the
author's recommendation: D-04 and D-22. (D-16 and D-24 had no firm recommendation: they are legal and economic
policy.) The table above is authoritative.

## 2. Decisions that need care or a follow-up

**D-04 (fuller minimum).** Requiring a description and a location or service area raises the bar for every business and
makes the submission validator stricter. It is consistent with the neutral-discovery rule. Consequence: the default-locale
description is a required field, and a profile with no location and no service area cannot be submitted.

**D-22 (moderators also see team and subscription details).** This goes beyond the minimum recommended in the
Security document (threat T-18 and the matrix). It does not contradict a locked rule: team and subscription data are
business data, not customer data, and platform staff already have platform-level business views. Required safeguards,
to be designed in BDPN-01B and verified in BDPN-01E:

- read-only, and only for holders of the moderation permission (D-03: platform admins);
- the extra view must be audited like every moderation action;
- **no customer data, loyalty data, Community Points, Partner Credit data or billing secrets** are part of this view;
- the data shown is limited to what moderation needs (for example the team size and role names, and the plan name),
  not payment details or personal contact data.

**D-24 (plan gating).** The owner chose "only on certain plans". This is an **economic policy** and was deliberately
not recommended by the author. Open follow-ups, none decided:

1. which plans include publication;
2. how entitlement is checked, and what happens to a live profile if a business moves to a plan without it (hide,
   keep until renewal, or grace period);
3. how this interacts with the Split 08 financial restrictions.
   Constraint: an entitlement check may **read** the business's current plan, but must not change billing, Stripe or
   subscription state. Until the owner decides items 1 and 2, the design keeps publication **unlimited in the model**
   and treats the plan check as one additional term in the eligibility predicate, so it can be added without changing
   the data model.

**D-16 (interim content policy).** The draft exists to unblock BDPN-01B. It is a starting point written by the
author, not a legal document, and not in force until approved.

**D-19 (backlog first).** This sets an order: the 23 pending migrations (including `0067`, merged but not applied
anywhere) are applied to staging, then production, before BDPN adds its single new migration. This needs a written
backlog plan (order, backups, verification, rollback) and a separate explicit authorization for each environment.
Nothing is applied by this record.

## 3. Changes the existing documents will need (not made here)

| Document                     | Change implied by the decisions                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Specification, section 2.2   | Required fields for submission become: display name, summary, description (default locale), category and at least one location or service area (D-04). Contact: website only (D-07). No media rows in v1 (D-05). Subcategories removed from v1 (D-08). |
| Specification, section 3.2   | T9 re-publish is immediate when the approved revision is unchanged and still eligible (D-13). Every edit creates a new reviewed revision (D-14).                                                                                                       |
| Specification, section 3.4   | The eligibility predicate gains a plan-entitlement term, defined only after D-24 follow-ups.                                                                                                                                                           |
| Specification, section 4     | Identifier is the opaque handle (D-10). Caching is `no-store` (D-12). Authenticated customers only (D-09). Category names are localized from the catalog (D-11).                                                                                       |
| Specification, section 7     | `business_profile_revision_media` is deferred (D-05). The location table carries no coordinates (D-06).                                                                                                                                                |
| Security document, section 2 | Moderator row: platform admins only (D-03); moderators may also view team and subscription details under the safeguards above (D-22).                                                                                                                  |
| Sequence document, section 5 | Statuses of D-01 to D-25 as in section 1 of this record.                                                                                                                                                                                               |

These edits are intentionally not made in this PR so that the decision record stays a clean, reviewable statement of
what was decided. They belong to BDPN-01A to 01E.

## 4. What this unlocks, and what it does not

| Block                                          | Dependencies                                   | State                                                                   |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| BDPN-01A (data contracts and schema proposal)  | D-01, D-04, D-05, D-06, D-07, D-08, D-10, D-19 | **All decided; ready to authorize**                                     |
| BDPN-01B (validation and moderation authority) | D-02, D-03, D-04, D-13, D-14, D-15, D-16, D-21 | **Partly gated:** D-16 needs the owner's approval of the interim policy |
| BDPN-01C (discovery API design)                | D-09, D-10, D-11, D-12, D-17, D-25             | **All decided; ready to authorize**                                     |
| BDPN-01D (Community Hub integration design)    | D-18, D-20                                     | **All decided; ready to authorize**                                     |
| BDPN-01E (security, migration, release plan)   | D-19, D-20, D-24                               | **Partly gated:** D-24 follow-ups (which plans, behavior on downgrade)  |

All five are **design blocks**. No implementation block is authorized by this record. Each sub-block still needs its own
explicit owner authorization, and none starts automatically.

## 5. New items surfaced by these decisions

- **N-1** Which subscription plans include profile publication, and the behavior on downgrade (D-24 follow-up). Economic.
- **N-2** A written plan for the migration backlog (D-19). Prerequisite for the saved-language feature and for any BDPN schema.
- **N-3** Owner approval (and counsel review, if wanted) of the interim content policy (D-16).
- **N-4** Translated category names for `en, fr, es, ar` (D-11): who approves the wording.

> **Erratum (2026-11-12).** The statements in this document that staging is "at 45" or that "23 migrations are pending" are **superseded**. The repository record dated 2026-11-09 (commit 52b990c) reports both the production Neon project and the staging branch at 67 journal entries; only `0067` is beyond that record. The live state of each environment is **not verified**. See `BDPN_MIGRATION_PLAN_AND_STATE_CORRECTION.md`. The D-19 principle (backlog first, then one BDPN migration) stands; the backlog is `0067`.
