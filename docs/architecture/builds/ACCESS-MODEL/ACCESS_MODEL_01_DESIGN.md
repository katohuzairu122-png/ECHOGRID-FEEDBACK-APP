# ACCESS-MODEL-01: who signs in to which part (design, version 2)

**Status: DESIGN ONLY. Nothing here is built, migrated, deployed or authorized. Every block needs its own authorization. Financial activation remains NO-GO.**
Version 2, 2026-11-13. Supersedes version 1 in this pull request. Written from the owner's two handwritten sketches and the master directive, and verified against the code on `main` `532e65c4`. Labels: **VERIFIED** (seen in code or run records), **PROPOSED** (a recommendation awaiting the owner), **BLOCKED**, **NOT IMPLEMENTED**, **NOT TESTED**.
Companion documents in this folder: `ACCESS_SEC_01_ASSESSMENT.md` (privileged-access security) and `WEB_1102_INCIDENT_REPORT.md` (production Web incident).

**Priority order: WEB-1102, then ACCESS-SEC-01, then AM-A to AM-F. No new Web feature goes to production until WEB-1102 is resolved and certified.**

## 1. The model (PROPOSED, from the owner's sketches)

| Audience           | Place 1                                                                                                                                                                                                                    | Place 2                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform admin** | **Platform console**: system operations. Platform-wide administration, authorization, configuration, business oversight, security status and audit visibility. Does **not** deploy code, run migrations or expose secrets. | **Platform business**: commercial operations. Subscriptions, participating businesses, plans, customer-count aggregates, community oversight, survey oversight, reports, support and legal status. |
| **Business admin** | **Business console**: management. Business settings, staff and roles, branches, billing and subscription, business-level administration.                                                                                   | **Business dashboard**: daily operations. Feedback, loyalty operations, customer service and QR, analytics, messages, authorized survey activities.                                                |
| **Customer**       | **Loyalty**: independent memberships, balances, rewards, business relationships, customer QR.                                                                                                                              | **Community**: Points and Membership, and the future Feed, per NETWORK-00.                                                                                                                         |

Constraints: preserve business isolation and the owner, manager and cashier permissions; keep the single top-level Community navigation; **no second global customer account**.

## 2. Sign-in and destination selection (PROPOSED)

After **any successful authentication**, work out which destinations the authenticated identity may use:

- **One** authorized destination: enter directly.
- **More than one:** show a "Where to?" chooser, and provide an authorized switch control inside each workspace.
- Never reveal roles, destinations or the existence of an administrative account **before** authentication.

**Correction to version 1 (D6):** the chooser follows any currently authorized method, not only a password. That includes customer OTP today and customer password login once it is approved and built.

### Separate identity domains (VERIFIED, constraint)

Customer and staff authentication are separate domains in the code: customers use phone OTP (`/customer-auth/otp/*`), staff and platform users use email and password. A shared phone, email or name must **never** link them automatically. If one person genuinely has customer, business and platform identities, linking requires: independent verification of each identity, explicit binding and authorization, server-side role and permission checks, separate session trust domains, auditable link and unlink, and protection against role escalation and session substitution. **The chooser is not an authorization mechanism:** every backend request enforces actor, tenant, role, session and permission on its own. Until a linking design is approved, a chooser can only offer destinations within **one** authentication domain (for example a staff identity that also has a platform role).

## 3. Owner decisions D1 to D6 (PROPOSED, none yet ratified)

These are recommendations, not locked architecture. **No approval is inferred from a recommendation.**

| #   | Topic                      | Proposed ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Platform console authority | Platform-data and participating-business administration only. No code deploy, no migration execution, no secrets. **Amendment: platform impersonation is NOT approved for v1.** Future impersonation needs its own design: explicit support purpose, time-limited elevation, full audit evidence, approval boundaries, no silent escalation, and independent protection of financial actions.                                                                        |
| D2  | Survey creation            | Version 1 is **oversight**: view, pause, close. Platform-created surveys are deferred to a later approved block.                                                                                                                                                                                                                                                                                                                                                     |
| D3  | Customer numbers           | **Aggregate counts only:** total unique platform customers, per-business counts within authorized scope, new customers in a selected period. **No** platform-wide customer-list browsing and **no** customer export. Needs defined counting semantics, small-group privacy protection (suppress or round very small counts), audit logging, and no identity leakage through detailed filtering. Distinguish global unique customers from business membership counts. |
| D4  | Legal                      | Read-only legal status in v1: current document versions, applicable policy version, publication and effective dates, and terms-acceptance status **where evidence exists**. Legal request workflows are deferred.                                                                                                                                                                                                                                                    |
| D5  | Remember destination       | Do not remember the last choice in v1. Single-destination accounts enter directly; multi-destination accounts choose each time. Switching must not weaken session isolation.                                                                                                                                                                                                                                                                                         |
| D6  | Chooser timing             | After successful authentication by any authorized method (see section 2). No pre-authentication role lookup.                                                                                                                                                                                                                                                                                                                                                         |

## 4. Corrections to version 1 of this document

1. D6 widened from "after a password" to any authorized authentication method.
2. D1 amended: impersonation not approved for v1. **Version 1 listed impersonation as an admin and support capability; it is in fact already implemented (see section 5), which conflicts with the amendment.**
3. D3 expanded with counting semantics and small-group protections.
4. **Terms acceptance:** version 1 said it is "recorded at signup". **That is not verified.** The signup form has a required checkbox and the action reads it, but no stored acceptance record was found in the API or database schema. A legal status page showing acceptance evidence would need new storage (its own migration block).
5. Added the separate-identity-domains rule and the rule that the chooser is not authorization.
6. The two handwritten lines ("creates surveys" and "final customer number") remain the owner's to confirm against the original drawings; they are carried as PROPOSED readings only.
7. Block sequence re-ordered so production stability and platform security come first.

## 5. Current implementation (VERIFIED against source, `main` `532e65c4`)

| Capability                                                                                                   | Classification                                                                                       | Evidence                                                             |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Platform console pages: overview, businesses, audit log, billing, plans                                      | **IMPLEMENTED**                                                                                      | `apps/web/src/app/platform/*`                                        |
| Platform roles `support`, `billing`, `admin`                                                                 | **IMPLEMENTED**                                                                                      | `requirePlatformRole`; one active admin in production                |
| Platform role provisioning                                                                                   | **NOT IMPLEMENTED** (script and database only)                                                       | no write path in API or web                                          |
| Second factor for staff or platform sign-in                                                                  | **NOT IMPLEMENTED**                                                                                  | no MFA code outside customer OTP                                     |
| Impersonation                                                                                                | **IMPLEMENTED** (support and admin; 30-minute token; audited)                                        | impersonate button and API route                                     |
| Business status change                                                                                       | **IMPLEMENTED** (admin; audited)                                                                     | `PATCH /platform/businesses/:id/status`                              |
| Customer counts in platform pages                                                                            | **DATA ONLY**                                                                                        | no count on the business detail page; none in the directory API      |
| Community oversight                                                                                          | **API ONLY**                                                                                         | community rules, ledger and adjustments routes; no console page      |
| Survey oversight (platform)                                                                                  | **NOT IMPLEMENTED**                                                                                  | surveys are business-scoped; no platform survey route                |
| Reports and support                                                                                          | **PARTIAL**                                                                                          | audit log and read-only role; no reports page or support-ticket tool |
| Legal pages                                                                                                  | **IMPLEMENTED** (public terms, privacy, refunds, cookies)                                            | web routes                                                           |
| Terms-acceptance record                                                                                      | **NOT IMPLEMENTED** (checkbox only)                                                                  | see correction 4                                                     |
| Business dashboard areas: feedback, loyalty, analytics, messages, notifications, settings, branches, billing | **IMPLEMENTED** as one combined area                                                                 | `apps/web/src/app/dashboard/*`                                       |
| Business console and dashboard split                                                                         | **NOT IMPLEMENTED**                                                                                  | single dashboard navigation                                          |
| Sign-in "Where to?" chooser                                                                                  | **NOT IMPLEMENTED**                                                                                  | login always redirects to `/dashboard`                               |
| Customer OTP login                                                                                           | **IMPLEMENTED**                                                                                      | `/customer-auth/otp/request` and `/verify`                           |
| Customer password login                                                                                      | **NOT IMPLEMENTED as a feature.** A password service exists in code but is not wired into any route. | no importer outside its own file                                     |
| Customer session tables (`0068`)                                                                             | **APPLIED in production, EMPTY, unused**                                                             | read-only production counts, 2026-11-13                              |

## 6. Platform business authorization matrix (PROPOSED)

None of the new rows below exist today. Every mutation needs a server-side permission check and a durable audit trail. **Platform roles are never granted automatically to business Owners or Managers.**

| Area                       | Support               | Billing                  | Platform Admin                     |
| -------------------------- | --------------------- | ------------------------ | ---------------------------------- |
| Businesses (exists)        | Read                  | Read                     | Read and authorized administration |
| Billing and plans (exists) | Read                  | Read and plan management | Administrative access              |
| Customer counts            | Authorized aggregates | Authorized aggregates    | Authorized aggregates              |
| Community                  | Read                  | No access                | Authorized management              |
| Surveys                    | Read                  | No access                | View, pause, close                 |
| Reports and support        | Read                  | Read                     | Authorized management              |
| Legal status               | Read                  | Read                     | Read                               |

Note: the existing community API routes admit `support`, `billing` and `admin` for reads, which is wider than "Billing: no access" above; reconcile when the page is built.

## 7. D-C1 cashier compatibility (VERIFIED state, constraint)

Production reconciliation was **verified** (not assumed): D-C1 Phase A and Phase B were applied on 2026-11-13. Staff roles now hold only `business:view`, `branches:view` and `loyalty:serve`; Owner, Admin and Manager also hold `loyalty:adjust` and `loyalty:accounts:view`. The console and dashboard redesign must keep: Owner and Manager administration, cashier service-only access, tenant isolation, branch authorization, and explicit authorization for purchase recording and reward redemption. Navigation components must not reintroduce sensitive routes; server-side permissions remain authoritative.

## 8. Customer authentication compatibility (constraint)

Remain compatible with CUSTOMER-AUTH-01: one persistent global customer identity; Twilio OTP at first phone verification; secure password login only after approved implementation; no unnecessary OTP on routine business QR scans; verified recovery; secure revocable sessions; separate business loyalty consent; no automatic customer and staff linking; no data loss or duplicate accounts. Migration `0068` is applied in production but its tables are empty and unused, so **customer password login is not active**. No access-model change may activate it or change OTP behavior.

## 9. Roadmap: independently gated blocks (authoritative sequence)

| Block                | Content                                                                                                                                                                                      | Gate                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **0. WEB-1102**      | Diagnose the CPU-limit regression, confirm deployed versions, prepare a minimal remediation. See `WEB_1102_INCIDENT_REPORT.md`.                                                              | **Release blocked until verified.**                                   |
| **1. ACCESS-SEC-01** | Privileged authentication (application MFA, optionally Cloudflare Access), break-glass, role provisioning. See `ACCESS_SEC_01_ASSESSMENT.md`.                                                | Owner decisions; no production security change without authorization. |
| **2. AM-A**          | Owner ratifies D1 to D6 and confirms this document.                                                                                                                                          | Owner.                                                                |
| **3. AM-B**          | Post-authentication "Where to?" chooser (section 2). Web only, no migration unless justified.                                                                                                | Own authorization; after block 0.                                     |
| **4. AM-C**          | Platform business area, as separate reviewable sub-blocks: customer counts, community oversight, survey oversight, reports and support, legal status, authorized billing and business pages. | Own authorization; **requires block 1 enforced**.                     |
| **5. AM-D**          | Split business console and dashboard; compatibility redirects only where safe; D-C1 permissions authoritative.                                                                               | Own authorization.                                                    |
| **6. AM-E**          | Customer Loyalty and Community destination selection, per the approved customer authentication flow and NETWORK-00.                                                                          | Own authorization.                                                    |
| **7. AM-F**          | Platform-created surveys, legal request workflows, any separately approved privileged support (including impersonation).                                                                     | Not in version 1.                                                     |

## 10. Test requirements for the future implementation

- **Authentication and navigation:** customer-only, business-only, platform-only identities; identities with two and with three destinations; failed authentication; expired sessions; logout; unauthorized destination access; session switching; cross-role linking; existing customer OTP; customer password login once implemented.
- **Authorization:** platform support, billing and admin; business owner, manager, cashier staff and custom roles; suspended and revoked actors; unauthorized API requests; cross-tenant access; audit-log completeness. Use real permissions and persisted session state, not hidden links.
- **Production compatibility:** old Web with new API; new Web with the approved API; browser and mobile behavior; Worker CPU usage; no uncontrolled request loops; production rollback verification.

## 11. Pull requests and roadmap handling

- PR #403 (roadmap refresh) is **open**. To avoid conflicting edits to the roadmap file, this document does not edit `ECHO_GRID_ROADMAP.md`. **Proposed integration sequence:** merge #403 first, then a small documentation PR adds a track for these blocks pointing here (and records the Web incident), keeping one authoritative roadmap.
- PR #404 (platform console guide) is open and independent.
- PR #405 CI: exact head `d2ed66ff` earlier failed one unrelated browser test (`e2e/dialog-theme.spec.ts`, "New branch" dialog not visible within 5 s) and **passed on re-run** (run 43436249521, attempt 2). On unmodified `main`, CI/CD is green on `532e65c4` (run 43416180762), so the failure did not reproduce there. Treated as a flake, with a note in the incident report.

## 12. Related backlog (not part of the access model)

- **Signup page has no background watermark** (owner screenshot, 2026-11-13): the "Create your account" page lacks the Echo Grid watermark pattern that the workspace pages have. Recorded for later; **not built**.
- Simplify the business-side feedback form builder; messages page inline retry.

## 13. Open owner decisions

1. Ratify or amend D1 to D6, including the impersonation amendment and what to do about the live impersonation capability.
2. Confirm the two handwritten lines (surveys; final customer number).
3. MFA versus Cloudflare Access (or both), and the break-glass design (ACCESS-SEC-01).
4. Whether terms-acceptance evidence is wanted in version 1 (requires new storage).
5. Approval to build any block.

## 14. Release assessment

**Web release: NO-GO** (WEB-1102 open). **Privileged-access expansion: NO-GO** (ACCESS-SEC-01 not built). API and database changes already deployed are unaffected by this document. This document does not authorize any release, privileged-access change or implementation.
