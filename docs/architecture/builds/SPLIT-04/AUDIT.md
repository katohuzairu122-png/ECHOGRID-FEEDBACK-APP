# ECHO GRID — SPLIT 04 REPOSITORY AUDIT
## Surveys & Participation

**Status:** COMPLETE  
**Branch:** `architecture/split-04-surveys-participation`

| Area | Current repository | Classification |
|---|---|---|
| Feedback form definitions | Present and versioned | KEEP IN FEEDBACK DOMAIN |
| Feedback answers | Present | KEEP IN FEEDBACK DOMAIN |
| Customer global identity | Present from Split 01 | REUSE |
| Business/customer membership | Present from Split 01 | REUSE |
| Consent grant purpose `survey_participation` | Present | REUSE / RECONCILE |
| Business QR resolver | Present from Split 03 | ADAPT ADDITIVELY |
| Customer QR identity | Present from Split 03 | REUSE |
| Cloudflare Queues | Present | REUSE FOR NON-AUTHORITATIVE ASYNC WORK |
| Dedicated survey definitions | Missing | ADD |
| Survey immutable versions | Missing | ADD |
| Survey campaigns / availability | Missing | ADD |
| Survey participant eligibility | Missing | ADD |
| Durable survey participation | Missing | ADD |
| Survey answer source of truth | Missing | ADD |
| Idempotent survey completion evidence | Missing | ADD |
| Explicit survey permissions | Missing | ADD / RECONCILE |
| Community Point issuance | Not implemented | DEFER SPLIT 05 |
| Orphan settlement | Not implemented | DEFER SPLIT 06 |
| Partner layer | Not implemented | DEFER SPLIT 07 |
| Billing/economic integration | Existing legacy billing only | DEFER ARCHITECTURE RECONCILIATION TO SPLIT 08 |
| PR #51 branch-level loyalty/community implementation | Open draft, based before Splits 01–03 | QUARANTINE |

## Key findings

### 1. Feedback is not surveys

The existing feedback domain already has a useful immutable-version pattern:

```text
feedback_forms
feedback_form_versions
feedback_questions
feedback_answers
```

That pattern can inform implementation, but these tables must not become the survey source of truth.

### 2. Split 01 already supplied survey consent vocabulary

`consent_grants.purpose` already includes:

```text
survey_participation
```

Split 04 should integrate this existing authority rather than create a second consent store.

### 3. Split 03 deliberately left survey actions absent

The frozen Split 03 resolver specification states survey actions are deferred to Split 04. Therefore Split 04 should extend the resolver additively and must not change QR identity semantics.

### 4. Existing queue infrastructure removes n8n as a blocker

Echo Grid already has a Cloudflare queue consumer and DLQ. Survey completion must commit authoritatively to Postgres first; optional notifications/analytics can use the queue afterward.

### 5. PR #51 cannot be merged

PR #51 includes:
- obsolete migration number `0034_branch_loyalty_community_v1.sql`;
- branch-level loyalty ownership assumptions that conflict with locked business-level loyalty;
- feedback/community changes created before current Split 01–03 boundaries.

It remains source material only.

## Implementation order

```text
1. shared survey types/validators
2. survey schema + migration 0037
3. repositories
4. authorization + permissions
5. survey management service/routes
6. participant eligibility/start/submit service
7. consent integration
8. idempotent completion
9. QR resolver additive actions
10. web surfaces
11. unit + integration + isolation tests
12. build/migration verification
13. completion report
14. PR
```

## Conflict rule

Any implementation pressure to:
- reuse feedback rows as reward-bearing survey evidence,
- issue Community Points in Split 04,
- create branch-owned loyalty balances,
- embed reward authority in QR tokens,
- merge PR #51 directly,

is an architecture conflict and must stop for review.
