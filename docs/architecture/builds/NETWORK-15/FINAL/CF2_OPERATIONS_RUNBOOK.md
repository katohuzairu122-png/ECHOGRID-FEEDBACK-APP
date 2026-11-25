# Community operations runbook (O-1 … O-7) — DRAFT FOR OWNER APPROVAL

Every human assignment below is **PENDING**. No person, approval date, threshold or response time is invented. Proposed targets are marked as proposals.

## O-1 Accountability
Accountable product owner (proposed): INFINICUS LLC Owner. Release operator: **[HUMAN ASSIGNMENT REQUIRED]**. A release operator may execute only pinned, protected workflows and cannot grant legal or activation approval.

## O-2 Reviewers (assignment records — all blank)
| Role | Name | Reference | Date |
|---|---|---|---|
| Qualified legal reviewer | ______ | ______ | ______ |
| English legal reviewer | ______ | ______ | ______ |
| French legal reviewer | ______ | ______ | ______ |
| Spanish legal reviewer | ______ | ______ | ______ |
| Arabic legal reviewer (incl. reading order, numbers, dates) | ______ | ______ | ______ |

## O-3 Support and incidents
**Severity (proposed):** S1 any suspected unauthorized activation, consent-evidence or ledger corruption, or enrollment possible while the gates should be off; S2 enrollment failing for valid customers, consent-write errors, deletion-lifecycle conflicts; S3 single-customer issues; S4 questions.
**Escalation:** support owner [ASSIGN] → incident lead [ASSIGN] → Owner. S1 goes to the Owner immediately.
**Emergency containment (Owner action):** unset/`false` the operation gates (stops new enrollment; deletes nothing); optionally set `COMMUNITY_MEMBERSHIP_PILOT_REQUIRED=true` and revoke affected customers; never edit consent, ledger or audit rows by hand.
**Evidence to capture:** customer id (internal only), request time, route and HTTP status/`code`, `audit_log` transition ids, the Worker version id, the `community_membership.control` log events. No consent text beyond ids/hashes in tickets.
**Customer communication templates (drafts, to be localized and approved):** (a) "Community is not available for your account yet." (pilot not eligible); (b) "Your account is scheduled for deletion; restore it to use Community." (deletion pending); (c) "We could not confirm your request; nothing was changed. Please try again." (failed enrollment); (d) dispute acknowledgement: "We received your request and will review it. [[TIMELINE: Owner decision]]".

## O-4 Monitoring (signals exist; thresholds are NOT invented)
| Signal | Source | Threshold |
|---|---|---|
| Enrollment failure rate | Workers request logs: HTTP 5xx/409 on `/community/me/join` | **TO BE DERIVED** from staging rehearsal request volumes |
| Consent-write errors | `community_membership.control` reason `transition_failed` | any occurrence in the pilot = investigate (proposal) |
| Unauthorized activation attempts | HTTP 403 `COMMUNITY_PILOT_NOT_ELIGIBLE`; `pilot_not_eligible` event | **TO BE DERIVED** |
| Pilot eligibility violations | an active membership for a customer with no grant event (SQL check below) | any row = S1 (proposal) |
| Ledger inconsistencies | SQL check below | any row = S1 (proposal) |
| Deletion conflicts | HTTP 409 `COMMUNITY_ACCOUNT_DELETION_PENDING`; `deletion_pending` event | informational |
| Policy version errors | HTTP 409 consent-stale / `COMMUNITY_TERMS_UNAVAILABLE` | **TO BE DERIVED** |
| Worker runtime failures | Workers error rate | **TO BE DERIVED** |
Note: the existing `community_membership.control` events are deliberately bounded (once per isolate per reason) and are not counters; rates come from request logs. No observed metrics exist yet (nothing has run on staging); do not quote any.
**Read-only integrity queries (templates, run by an approved operator only):**
- Eligible-state mismatch: members activated after pilot mode began without a grant: `select m.customer_id from community_memberships m where m.status='active' and not exists (select 1 from community_pilot_eligibility_events e where e.customer_id=m.customer_id and e.action='grant')` (meaningful only for customers activated while pilot mode was required).
- Ledger conservation per account: `select a.id from community_point_accounts a where a.points_balance <> coalesce((select sum(points) from community_point_transactions t where t.account_id=a.id),0)`.
- Deletion conflict: `select m.customer_id from community_memberships m join customer_deletion_requests d on d.customer_id=m.customer_id and d.status='pending' where m.status='active'` (an active member with a pending deletion is expected to be rare and is informational).

## O-5 Retention (categories; durations pending qualified review)
Categories: consent evidence (immutable transitions + grants); membership history; Community Points ledger; audit log (immutable); deletion-request records; pilot eligibility events (immutable). **Durations: PENDING legal.** Legal holds: a hold prevents any processing of the customer's deletion (existing D2-FINAL engine); the hold procedure and owner are PENDING. Do not invent retention periods; do not erase evidence to satisfy a deletion request before the policy is approved.

## O-6 Disaster recovery — feasibility of the proposed targets (RPO ≤ 24 h, RTO ≤ 4 h)
Read-only facts (Neon, 2026-11-25): both projects run PostgreSQL 18; **production point-in-time history retention is 21 600 s (6 h)**, staging 86 400 s (24 h); production has **no automatic snapshot schedule** (empty), and a manual snapshot exists from the production migration.
- **RPO ≤ 24 h: NOT currently met for production.** A problem noticed more than 6 h later cannot be recovered by point-in-time restore, and no scheduled snapshot fills the gap. Options (Owner decisions): raise production history retention to ≥ 24 h, and/or add a daily snapshot schedule. Neither is done here.
- **RTO ≤ 4 h: UNPROVEN.** Neon branch restore is fast, but the full path (restore → verify → repoint Hyperdrive origin → verify app) has not been drilled. A timed restore drill on staging is required before this target can be claimed.
- Backup verification procedure: monthly timed restore of the latest snapshot/PITR point into a disposable branch; verify ledger count, data fingerprints and guard triggers (as in the migration reconciliation), then delete the branch.

## O-7 Pilot
- **Synthetic staging pilot (first):** after the staging migration is authorized and executed: seed approved-or-clearly-marked-test terms in staging only; enable one gate at a time with `COMMUNITY_MEMBERSHIP_PILOT_REQUIRED=true`; grant eligibility to synthetic customers only; exercise Join → Leave → Rejoin → suspend/clear → Restore, deletion-request interplay, revocation, duplicate and concurrent requests, four languages and Arabic RTL; collect real request-rate and error data to derive O-4 thresholds.
- **Controlled production pilot (later, separate authorization):** pilot mode required; a small named allowlist; scope = the Owner's named customers only.
- **Expansion criteria (proposal):** a full observation window with zero S1/S2 incidents, integrity queries clean, support able to answer within the approved timelines. **Suspension criteria:** any S1; repeated S2; unapproved legal text discovered. **Rollback:** unset the gates (or revoke eligibility); existing memberships and evidence are retained. **Success criteria (proposal):** members can join, leave and restore with fresh consent; no integrity query returns a row; support load within the approved capacity.
- **Not activated by this workstream.**
