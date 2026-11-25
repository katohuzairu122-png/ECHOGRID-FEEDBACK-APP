# G5–G8 — containment evidence, operations, deployment checklist and activation decision

**Nothing here deploys, migrates, publishes or activates anything.** Prepared 2026-11-25 against `main` `1ef2145ffbd46254e8bacacf9634b1c57e477a79`.

## G5 — runtime security and containment (reconciled against current code)
AR02 listed containment as "specification only, BLOCKED". That is **superseded**: CONTROL-01 was implemented and merged in #566 (`a657770`).
| Requirement | Evidence in current code |
|---|---|
| Independent fail-closed controls for Join, Rejoin, Restore and platform clearance | `apps/api/src/community/community-membership-controls.ts`: four keys `COMMUNITY_MEMBERSHIP_{JOIN,REJOIN,RESTORE,CLEARANCE}_ENABLED`; enabled only by the exact string `"true"`; absent or any other value disables; disabled mutations answer 503 `COMMUNITY_MEMBERSHIP_OPERATION_DISABLED` |
| No back door around the routes | The membership repository checks an opaque, DB-bound, operation-specific permit on every `create`/`updateStatus`; only two services write memberships (`community-membership.service.ts`, `community-platform-state.service.ts`); grep found no other writer |
| Feed flag is not the enrollment kill switch | `isNetworkFeedEnabled` is used only by `community-feed.routes.ts` and `network-moderation.routes.ts`; the enrollment routes and services never read `NETWORK_FEED_ENABLED` |
| No automatic enrollment | Loyalty join code never references Community memberships; the only membership writers are the explicit Join/Rejoin/Restore and platform paths |
| Flags are off in the repository | No `COMMUNITY_MEMBERSHIP_*` or `NETWORK_FEED_ENABLED` appears in any `wrangler*.toml` or workflow |
| Adversarial tests | `community-membership-controls*.test.ts` and `community-membership-controls.integration.test.ts`: forged/cross-customer/cross-DB permits, disabled paths, concurrency (see certificate for this run's results) |
**Not verified (tooling limit):** the live values of those flags on the deployed Workers. The Cloudflare tool available here returns only a Worker's name and id, not its variables. The repository never sets them, so they default to off, but the Owner should confirm read-only in the Cloudflare dashboard (Workers → echo-grid-feedback-api and echo-grid-feedback-web → Settings → Variables) that none of the five names exist.
Residual limits (also stated in CONTROL-01): privileged raw SQL, old application versions and trusted code that supplies enabled config are outside a request-binding control's boundary; the runtime still connects as the table owner until the R8-G cutover.

## G6 — operational readiness
The drafted procedures already exist in `AR02/OPERATING_RECOVERY_MODEL.md` (support, consent disputes, failed enrollment, restoration failures, publication withdrawal, emergency containment, incident response, monitoring signals, retention and legal holds, ledger integrity, backup and recovery). They remain proposals. **No operator is named and no threshold or response time is invented.** Decisions the Owner must make:
| # | Decision | Needed from |
|---|---|---|
| O-1 | Name the accountable product owner and release operator | Owner |
| O-2 | Name the legal/policy approver and the four language reviewers | Owner |
| O-3 | Name the support owner and incident lead, with deputies and coverage hours | Owner |
| O-4 | Approve alert thresholds (enrollment failure rate, consent-write errors, ledger imbalance) and who is paged | Owner |
| O-5 | Approve retention periods for consent evidence and the legal-hold procedure (aligned with the deletion-request design, R7) | Owner + legal |
| O-6 | Approve RPO/RTO and the backup owner | Owner |
| O-7 | Decide the pilot scope for the first customers (the containment flags are global, not per-customer; a per-customer pilot mechanism does not exist) | Owner |

## G7 — protected deployment: verified facts and staged checklist
Verified in workflow source (`deploy-production.yml`): exact 40-hex `expected_commit` must equal the current tip of `main`; confirmation phrase `DEPLOY_PRODUCTION_RELEASE`; a full CI gate runs first; API and web deploy in separate jobs, each behind the `production` environment approval; the post-deploy 2E–2H checks run after. Migrations run only through the separate `migrate-production.yml` (`MIGRATE_PRODUCTION`) and `migrate-staging` workflows. No workflow sets any Community or Network flag. Rollback = redeploy the previous commit; no down-migrations.
Staged checklist (every step needs its own Owner instruction):
1. Staging: G2 authorization record executed (restore point first) → read-only verification (G2 section 7).
2. Staging: deploy the current `main` to the staging Workers (staging app is still an old build).
3. Staging: flags stay unset; verify all four enrollment attempts answer 503 and Feed stays hidden.
4. Staging: Owner sets one flag at a time only in a rehearsal with a seeded **staging** publication (needs approved or clearly marked test legal text) and exercises Join→Leave→Rejoin→Restore with synthetic customers.
5. Production: separate G2 record, fresh restore point, migrate, verify read-only.
6. Production: deploy only if code changed; flags stay unset.
7. Publication of approved legal bundle (staged non-current first), then G8.
Not verified here: the actual protected-environment reviewer settings in GitHub (self-review prevention, branch rules) and the environment secrets; the Owner must confirm in repository settings.

## G8 — activation decision record (blank by design)
Community enrollment stays **disabled**. It may be activated only after the Owner separately approves **every** line below; no line is pre-approved.
| Precondition | Status |
|---|---|
| G2 migration executed and verified on the target | NOT DONE |
| G3 final legal texts approved and published (staged non-current, then current) | NOT DONE |
| G4 four legal translations approved | NOT DONE |
| G5 live flag state verified; containment adversarial tests green on the deployed build | PARTIAL (code verified; live state not read) |
| G6 operators named, thresholds and procedures approved | NOT DONE |
| G7 protected deployment authorized (separate API and web approvals) | NOT DONE |
| Activation scope: which flag(s), which target, which date, pilot or global | DECISION NEEDED (O-7) |
| Rollback plan accepted: set the flag(s) back to unset/`false`; existing memberships and consent evidence are retained | DRAFT |
Owner decision: ______ Date: ______ Signature: ______
