# ACCESS-MODEL-01: who signs in to which part (design only)

**Status: DESIGN ONLY. Nothing here is built, migrated, deployed or authorized. Every block needs its own authorization.**
Written 2026-11-13 from the owner's two handwritten sketches and the code on `main` `532e65c4`. Where a handwritten line was unclear it is marked "reading" and the owner should correct it. Financial activation remains NO-GO.

## 1. The model

Three audiences, two places each:

| Audience           | Place 1                               | Place 2                                               |
| ------------------ | ------------------------------------- | ----------------------------------------------------- |
| **Platform admin** | **Platform console**: system side     | **Platform business**: commercial and operations side |
| **Business admin** | **Business console**: management side | **Business dashboard**: daily work                    |
| **Customer**       | **Loyalty**                           | **Community**: access to the Echo Grid community      |

Platform admin sits above business admin, who sits above customer. One account can hold roles at more than one level. After a correct sign-in, a person with more than one place is asked where to go; a person with one place goes straight there.

## 2. Platform console and platform business (owner's notes)

**Platform console** (reading: controls all sides and makes changes across the platform). **Platform business** (reading of the list):

- controls billing;
- reports and support;
- controls businesses' participation in the community hub;
- creates surveys (reading, uncertain);
- views the businesses that have joined;
- sees total customers per business and the final customer number (reading, uncertain);
- legal.

### Current state of each item (verified in code)

| Item                    | Today                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Billing                 | Exists: `/platform/billing` and plans. Roles: support/billing/admin read, billing/admin edit plans.                                      |
| Businesses that joined  | Exists: directory and detail pages, status change (admin), impersonation (support/admin).                                                |
| Reports and support     | Partly: audit log and read-only support role. No reports page and no support-ticket tool in the console.                                 |
| Community participation | API routes exist (platform community rules, point ledger, adjustments). No console page.                                                 |
| Surveys                 | Surveys are created by each business (business-scoped permissions). No platform-level survey function.                                   |
| Customer totals         | Data exists in the database. No console page.                                                                                            |
| Legal                   | Public terms, privacy, refunds and cookies pages exist, and terms acceptance is recorded at signup. Nothing in the console manages them. |

## 3. Recommended answers to the open questions

1. **"Changes on the full architecture."** The console controls platform **data and businesses** (status, plans, roles, community participation). It does **not** deploy code, run migrations or hold secrets. Those stay in the release pipeline with protected approvals. Reason: an app screen that can change infrastructure would make a stolen admin login far more damaging.
2. **"Creates surveys."** Version 1 is **oversight**: view surveys across businesses and pause or close one that breaks the rules. Platform-created surveys come later as their own block, because surveys are business-owned today and a platform survey needs its own ownership and consent rules.
3. **"Final customer number."** Show three counts only: total unique customers across all businesses (counted once per person), customers per business, and new customers in a period. **Counts, not customer lists or personal details, and no export in version 1.**
4. **"Legal."** Version 1 is a **read-only legal status page**: the current document versions and the terms-acceptance record. Legal requests (data export and deletion, compliance records) are a later block. Legal text changes stay in the code-review process.

## 4. Access rules (proposed)

| Platform business page     | support | billing          | admin                     |
| -------------------------- | ------- | ---------------- | ------------------------- |
| Businesses (exists)        | read    | read             | read, status, impersonate |
| Billing and plans (exists) | read    | read, edit plans | all                       |
| Customer counts            | read    | read             | read                      |
| Community participation    | read    | none             | edit                      |
| Survey oversight           | read    | none             | pause, close              |
| Reports and support        | read    | read             | all                       |
| Legal status               | read    | read             | read                      |

The sign-in chooser appears **only after** a correct password, so the login form never reveals that an account has a platform role. A chosen place is not remembered: the person is asked each time. Every state-changing platform action is written to the audit log.

## 5. Prerequisites before expanding platform powers

1. **Two-factor sign-in or Cloudflare Access in front of `/platform`.** Platform accounts have no two-factor today, and the account can act across every business.
2. **A dedicated platform admin account plus a second break-glass admin**, as described in `docs/PLATFORM-CONSOLE-GUIDE.md`.
3. **A screen or tool to grant platform roles.** None exists; roles are set by a setup script or directly in the database.
4. **The web release must be stable in production.** The 2026-11-13 web release was rolled back for a Worker CPU-limit error; new web features should not ship until that is understood.

## 6. Proposed blocks (each separately authorized)

| Block | Content                                                                                                                    | Gate                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| AM-A  | Owner corrects the readings in section 2 and confirms section 3                                                            | Owner                                          |
| AM-B  | Sign-in "Where to?" step for people with more than one place; switch link in each area. Web only, no database change       | Own authorization                              |
| AM-C  | Platform business area: customer counts, community participation page, reports and support, legal status, survey oversight | Own authorization, after prerequisites 1 and 2 |
| AM-D  | Split the business area into Business console and Business dashboard; regroup navigation by permission                     | Own authorization                              |
| AM-E  | Customer chooser: Loyalty or Community, shown after customer sign-in                                                       | Own authorization                              |
| AM-F  | Platform-created surveys (later), and legal requests (later)                                                               | Own authorization, owner design                |

## 7. Risks

- A chooser changes how everyone signs in; test it with accounts that have one, two and three places.
- Splitting console and dashboard touches many pages and permissions; it needs a staging check with each business role.
- Customer counts across businesses are personal-data aggregates; keep them counts-only and audited.
