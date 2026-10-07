# ECHO GRID — SPLIT 04
## Surveys & Participation
### Implementation Specification v1.0

**Status:** FROZEN FOR EXECUTION  
**Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`  
**Branch:** `architecture/split-04-surveys-participation`  
**Base:** current `main` after merged Split 03  
**Master authority:** Echo Grid Master Architecture v1.0  
**Split:** 04 of 10

---

## 1. Purpose

Split 04 introduces the authoritative survey and participation domain required before Community Points.

This split must allow Echo Grid and authorized businesses to create and run structured surveys, allow eligible customers or non-buying participants to complete them, and create durable participation evidence that Split 05 may later evaluate for Community Point issuance.

Split 04 does **not** issue Community Points.

The survey system is distinct from:
- ordinary customer feedback,
- loyalty purchase events,
- business loyalty balances,
- Community Points,
- orphan reward settlement,
- Partner Credits,
- subscription billing.

---

## 2. Frozen domain boundary

```text
SURVEY DEFINITION
      ↓
SURVEY VERSION
      ↓
SURVEY QUESTION SET
      ↓
SURVEY CAMPAIGN / AVAILABILITY
      ↓
PARTICIPANT ELIGIBILITY
      ↓
SURVEY PARTICIPATION
      ↓
SURVEY RESPONSE / ANSWERS
      ↓
COMPLETION EVIDENCE
      ↓
Split 05 may later evaluate for Community Points
```

Survey completion is evidence.

It is not currency.

---

## 3. Relationship to existing feedback system

The repository already contains:
- `feedback_forms`
- `feedback_form_versions`
- `feedback_questions`
- `feedback_answers`

Those tables remain the business feedback domain.

They must not be repurposed into Community survey accounting because:
1. feedback represents a customer's response to a business interaction;
2. surveys may exist without a purchase;
3. survey participation may be platform/community sponsored;
4. survey completion may later qualify for Community Points;
5. feedback and survey retention, targeting and reward policy may diverge.

Split 04 may reuse implementation patterns, validators, UI concepts and versioning mechanics from feedback, but survey data must have separate authoritative tables and services.

---

## 4. Survey ownership

Initial supported survey owner types:

```text
platform
business
```

A platform survey is controlled by Echo Grid.

A business survey is controlled by one business and must remain tenant-isolated.

A business must never read another business's private survey responses unless an explicit later cross-business product specification permits it.

No direct business-to-business survey data access is introduced in Split 04.

---

## 5. Survey lifecycle

Minimum survey statuses:

```text
draft
published
paused
closed
archived
```

Only a published survey may accept new participation.

Closing a survey prevents new starts but preserves historical responses.

Published survey question content is immutable.

Changes after publication require a new version.

---

## 6. Survey versioning

Add immutable published survey versions.

Minimum model:

```text
surveys
survey_versions
survey_questions
```

A participation record references the exact survey version presented to the participant.

Historical answers must never silently shift meaning when a survey is edited.

---

## 7. Question model

Initial question types:

```text
text
textarea
rating
single_choice
multi_choice
boolean
number
```

Question fields should support:
- stable key
- label
- required flag
- position
- options where applicable
- validation metadata where justified

Do not introduce arbitrary executable expressions or dynamic code in question configuration.

---

## 8. Survey campaign / availability

Separate the survey definition from where and when it is available.

Add a campaign/availability entity that can constrain:
- owner
- survey version
- start time
- end time
- active state
- optional business
- optional branch
- intended audience class
- response limit policy
- optional QR/action exposure

Initial audience classes:

```text
customer
community_candidate
community_member
business_member
general_authenticated_participant
```

Exact Community membership economics remain Split 05.

Split 04 may represent eligibility categories but may not create Community Point balances.

---

## 9. Participant identity

A survey participation must resolve to an authenticated Echo Grid customer/participant identity before it can become reward-eligible evidence.

Anonymous feedback may continue under the feedback system.

Reward-eligible survey participation must not rely only on an anonymous browser session or raw QR token.

The authoritative participant reference is the global customer identity.

---

## 10. Non-buyer participation

A participant does not need a qualifying purchase to complete a survey.

This intentionally supports the locked product concept that non-buyers may participate in surveys and later earn Community Points under Split 05 policy.

Split 04 records participation only.

It does not calculate or issue those points.

---

## 11. Survey participation state

Add:

```text
survey_participations
```

Minimum fields:

```text
id
survey_id
survey_version_id
campaign_id
participant_customer_id
business_id nullable
branch_id nullable
status
started_at
completed_at nullable
submitted_at nullable
idempotency_key
source
created_at
updated_at
```

Initial statuses:

```text
started
submitted
completed
invalidated
```

If validation is synchronous, submitted and completed may occur in one transaction while remaining distinct semantic states.

---

## 12. Survey answers

Add:

```text
survey_answers
```

Each answer must reference:
- participation
- exact survey question
- stable question key
- question label snapshot where useful
- question type snapshot where useful
- validated value

The answer set must be validated against the immutable version that the participation references.

---

## 13. Idempotency

Survey completion must be idempotent.

Unique invariant should prevent duplicate economically relevant completion for the same allowed participation unit.

At minimum:
- a participation has a unique idempotency key within the relevant owner/campaign scope;
- replaying the same submission returns the existing result;
- replaying an idempotency key with materially different answers returns:

```text
409 IDEMPOTENCY_CONFLICT
```

The implementation must not create two completion records that Split 05 could later count twice.

---

## 14. Repeat-response policy

Repeat participation must be explicit campaign policy.

Initial policy values:

```text
once
once_per_campaign
repeatable
```

Default should be conservative:

```text
once_per_campaign
```

Repeatability does not imply repeated Community Point rewards.

Reward eligibility remains Split 05.

---

## 15. Completion evidence

A completed survey participation is authoritative evidence that:
- the participant identity was resolved;
- the survey/campaign was valid;
- the correct immutable version was answered;
- required answers passed validation;
- the completion was not a duplicate;
- the completion timestamp is known.

Split 05 may later consume this evidence.

Split 04 must expose a stable completion reference rather than requiring Split 05 to infer completion from raw answer rows.

---

## 16. No Community Points in Split 04

Prohibited in this split:
- Community Point balance tables
- Community Point ledger entries
- Community Point issuance
- redemption
- point valuation
- partner redemption funding
- subscription discounts
- orphan settlement
- Partner Credits

A field such as `reward_eligible` may only represent a policy/evidence flag if absolutely necessary and must not represent an awarded economic amount.

Preferred design: let Split 05 compute reward eligibility from durable participation evidence.

---

## 17. QR integration

Split 03 established server-side Business QR and Customer QR action resolvers.

Split 04 may add:

```text
TAKE_SURVEY
VIEW_AVAILABLE_SURVEYS
```

only when server-side policy confirms eligibility.

QR tokens must not embed:
- survey answers
- reward amount
- Community Point amount
- eligibility secrets
- balances

The QR remains an identity/context locator.

---

## 18. Consent and privacy

Existing consent infrastructure includes `survey_participation`.

Split 04 must use or explicitly reconcile that purpose instead of creating a parallel consent system.

Consent requirements depend on survey type and data collection purpose.

The survey system must store the minimum necessary participant data and must not expose cross-business customer activity to businesses.

Sensitive/free-text response data must remain tenant/platform scoped according to survey ownership.

---

## 19. Authorization

Platform-owned survey management requires platform authority.

Business-owned survey management requires:
- authenticated staff
- resolved tenant
- business-wide survey management authority

Branch-scoped staff may be permitted to view or facilitate a branch-targeted campaign only if explicitly authorized.

Branch context must never grant access to another business's survey definitions or responses.

---

## 20. Recommended permissions

Introduce or reconcile explicit permissions rather than overloading unrelated feedback permissions:

```text
survey:view
survey:manage
survey:responses:view
```

Platform survey administration remains under platform-role authorization.

Do not silently make `feedback:manage` the permanent authority for survey administration.

---

## 21. Suggested schema

Expected additive tables:

```text
surveys
survey_versions
survey_questions
survey_campaigns
survey_participations
survey_answers
```

Optional separate completion-event table is not required if `survey_participations` itself provides a durable unique completion reference and immutable completion state.

Prefer the smallest schema that preserves:
- version history
- idempotency
- participation evidence
- owner isolation
- future Split 05 consumption

---

## 22. Existing code to reuse carefully

Reuse patterns from:
- feedback form versioning
- feedback answer validation
- tenant middleware
- customer authentication
- consent grants
- QR action resolver
- audit logging
- queue infrastructure when asynchronous post-processing is needed

Do not merge the feedback and survey sources of truth.

---

## 23. Queue / automation boundary

n8n is not required.

Cloudflare Queues may handle non-authoritative asynchronous work such as:
- notifications
- survey completion analytics
- non-critical enrichment

The authoritative survey participation transaction must commit to Postgres before asynchronous side effects are queued.

A queue message must never be the only record that a participant completed a survey.

---

## 24. Required migration

Expected next migration:

```text
0037_split04_surveys_participation.sql
```

It should be additive.

It must not reuse PR #51's obsolete `0034_branch_loyalty_community_v1.sql` migration number or schema assumptions.

---

## 25. Required API surfaces

Suggested customer routes:

```text
GET  /api/v1/surveys/available
GET  /api/v1/surveys/:campaignId
POST /api/v1/surveys/:campaignId/start
POST /api/v1/surveys/:campaignId/submit
GET  /api/v1/surveys/me/participations
```

Suggested business management routes:

```text
GET    /api/v1/surveys
POST   /api/v1/surveys
POST   /api/v1/surveys/:id/versions
POST   /api/v1/surveys/:id/publish
POST   /api/v1/surveys/:id/pause
POST   /api/v1/survey-campaigns
GET    /api/v1/survey-campaigns
GET    /api/v1/survey-campaigns/:id/responses
```

Exact route naming may adapt to repository conventions, but domain boundaries may not.

---

## 26. Required tests

### Ownership and authorization
- Business A cannot view or mutate Business B surveys
- branch-scoped access cannot escape its authorized business/branch
- platform survey administration requires platform authority
- customer endpoints cannot authenticate with staff credentials and vice versa

### Versioning
- published version is immutable
- new edits create a new version
- participation remains bound to the original version

### Participation
- authenticated participant can start an eligible survey
- ineligible participant is rejected
- closed/paused campaign rejects new starts
- required answers are enforced
- invalid option values are rejected
- successful submission becomes durable completion evidence

### Idempotency
- identical replay does not create a second participation/completion
- conflicting replay returns 409
- repeat-policy limit is enforced

### Privacy
- business receives only its authorized responses
- cross-business participation state is not leaked
- QR payload contains no answers, balances or economic reward values

### Architecture
- survey completion does not mutate loyalty points
- survey completion does not mutate Community Points
- survey completion does not create settlement or Partner Credit entries

---

## 27. PR #51 quarantine rule

PR #51 (`feat/branch-loyalty-community-v1`) predates merged Splits 01–03 and contains overlapping branch-loyalty, feedback and community concepts.

Do not merge PR #51.

Useful concepts may be manually re-evaluated, but no migration, table, route, balance behavior or branch-level loyalty ownership assumption from that PR may be copied without reconciliation against the locked 10-split architecture.

Its `0034_branch_loyalty_community_v1.sql` migration is obsolete relative to current main, where 0034–0036 are already allocated to Splits 01–03.

---

## 28. Definition of Done

Split 04 is LOCKED COMPLETE only when:
- survey domain is distinct from feedback
- survey ownership is explicit
- versioned survey definitions exist
- campaigns/availability exist
- authenticated participant identity is authoritative
- non-buyers can participate without a purchase requirement
- participation and answers are durable
- completion is idempotent
- repeat policy is explicit
- completion evidence is stable for Split 05
- no Community Point economics are implemented
- QR resolver can expose eligible survey actions without embedding authority
- privacy and tenant isolation tests pass
- migration drift passes
- lint passes
- security gates pass
- API/web typecheck passes
- unit/integration tests pass
- builds pass
- completion report exists

---

## 29. Conflict rule

If implementation conflicts with the Master Architecture, Splits 01–03, or this frozen Split 04 specification:

**STOP AND REPORT. DO NOT INVENT A WORKAROUND OR REDESIGN THE ARCHITECTURE FOR CONVENIENCE.**
