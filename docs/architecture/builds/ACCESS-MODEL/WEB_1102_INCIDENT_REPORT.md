# WEB-1102: production Web Worker CPU-limit incident (read-only investigation)

**Status: INVESTIGATION RECORD. ROOT CAUSE NOT YET FOUND. No fix is proposed for deployment, and nothing here was deployed, rolled back or changed by this document.**
Written 2026-11-13 from GitHub run records, the repository at `main` `532e65c4`, the owner's Cloudflare Observability screenshot, and local measurements. Labels: VERIFIED, PROPOSED, BLOCKED, NOT IMPLEMENTED, NOT TESTED.

## 1. Verdict

**Release verdict: NO-GO for any production Web deploy** (including redispatching `532e65c4`) until this incident is diagnosed and a fix is certified. The API and database changes are separate and remain in place.

## 2. Verified timeline (UTC)

| When              | Event                                                                                                                                                                                                                                   | Source                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 2026-11-12 04:11  | Production web-only deploy of `b2f85ac0` succeeded (run 43153114639). Last web release before the incident.                                                                                                                             | GitHub run record: VERIFIED            |
| 2026-11-13 11:52  | Production migrations `0067` and `0068` applied (run 43420468101).                                                                                                                                                                      | VERIFIED                               |
| 2026-11-13 12:02  | Production release run 43421810874 started on `main` `532e65c4`.                                                                                                                                                                        | VERIFIED                               |
| 12:15 to 12:16    | API deployed (success).                                                                                                                                                                                                                 | VERIFIED                               |
| 12:22 to 12:23:53 | **Web deployed** (success); post-deploy checks 2E to 2H passed.                                                                                                                                                                         | VERIFIED                               |
| from about 12:24  | Cloudflare Observability shows "Worker exceeded CPU time limit" on `echo-grid-feedback-web`, script version `f2ae60ee`, on `GET /` and `GET /dashboard`. Red bars on the chart from about 12:33; log rows visible 12:42:51 to 12:48:27. | Owner screenshot: VERIFIED as reported |
| 12:42:51          | Owner reports Error 1102 on echo-grid.uk, Ray ID `a59ddbd89edbb903`.                                                                                                                                                                    | Owner screenshot                       |
| after 12:48       | Owner rolled the web Worker back in the Cloudflare dashboard; errors stopped.                                                                                                                                                           | Owner report                           |

The errors begin within about a minute of the web deploy finishing.

## 3. Versions

| Item                   | Value                                                                                                                                           | Status                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Impacted Web           | `main` `532e65c4`, Worker version `f2ae60ee`                                                                                                    | VERIFIED (run record and Observability) |
| Current production API | `532e65c4` (deployed 12:16 UTC)                                                                                                                 | VERIFIED                                |
| Current production Web | **Not recorded in GitHub.** The dashboard rollback returned the Worker to the previous version, most likely the `b2f85ac0` build of 2026-11-12. | **UNVERIFIED**                          |
| Production database    | migration 69 of 69 (`0068`), Phase A and B role grants applied                                                                                  | VERIFIED                                |

Next diagnostic action: the owner reads the active Web version id and its deployment date in Cloudflare (Workers, `echo-grid-feedback-web`, Deployments) and confirms it matches the `b2f85ac0` build.

## 4. Evidence

**Observed (owner screenshot, VERIFIED as reported):** error is the CPU execution limit ("Worker exceeded CPU time limit"; Cloudflare page "Error 1102, Worker exceeded resource limits"), not wall-clock latency or a memory error message. It affects the public landing page as well as the dashboard, so it is not specific to one feature.

**Local measurement (VERIFIED, NOT a production measurement):** I built the Worker at `b2f85ac0` and at `532e65c4` and ran both in Cloudflare's local runtime (workerd), measuring workerd CPU per request over 30 warm requests and the first (cold) request:

| Page                                | Old, warm | New, warm | Old, cold | New, cold |
| ----------------------------------- | --------- | --------- | --------- | --------- |
| `/`                                 | 39.3 ms   | 40.3 ms   | 290 ms    | 280 ms    |
| `/login`                            | 18.0      | 21.3      | 60        | 70        |
| `/signup`                           | 23.7      | 22.7      | 40        | 30        |
| `/privacy`                          | 19.0      | 21.7      | 40        | 40        |
| `/loyalty/login`                    | 19.3      | 18.0      | 80        | 110       |
| `/dashboard` (signed out, redirect) | 4.7       | 6.0       | 0         | 10        |

Main server bundle: 7.39 MB (old) to 7.56 MB (new), +2.3%. A CPU profile shows time spread across Next.js and React rendering inside one bundled file, with no single hot spot; function names are minified, so features cannot be attributed.

Caveats: this sandbox is not the Cloudflare edge, so absolute numbers do not transfer; only the old-to-new comparison does. A signed-in `/dashboard` could not be measured because it needs the API. Production CPU-time metrics were **not available** to me.

## 3a. What is NOT supported by the evidence

- "The new release made pages heavier": **not supported**. Measured per-request CPU is about the same.
- "The unread-badge polling caused it": **not supported** for these errors, because `/` does not run it. Polling remains a possible traffic contributor and is NOT TESTED under load.
- OpenNext, Next.js and authentication middleware were not shown responsible. The Worker runs Next.js in minimal mode (`NEXT_PRIVATE_MINIMAL_MODE`), so the Next.js middleware file is skipped; the landing page and dashboard layouts perform their own session checks.

## 5. Bounded hypotheses (none confirmed)

| #   | Hypothesis                                                                                                                                           | For                                                                                        | Against / unknown                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| H1  | The account's Workers plan CPU limit is low (for example the Free plan's 10 ms per request) and the pages sit near it; a small shift tips them over. | Even `/` costs about 40 ms locally; no `limits.cpu_ms` is set in `apps/web/wrangler.toml`. | The old release served traffic for days under the same limit. Plan is unknown to me. |
| H2  | Cold-start CPU (initialising a 7.5 MB server bundle) exceeds the limit when isolates are recycled; more cold starts after a deploy.                  | Cold requests cost 250 to 290 ms locally; errors began right after a fresh deploy.         | Old and new cold costs are equal locally.                                            |
| H3  | A Cloudflare-side or account-side event at about 12:24 UTC coincided with the deploy.                                                                | Rollback to a different Worker version also changes the isolate set.                       | No evidence either way.                                                              |
| H4  | Traffic shape changed (for example a burst of requests right after deploy).                                                                          | Unknown.                                                                                   | Not tested.                                                                          |

## 6. Evidence still needed (read-only, owner side)

1. Cloudflare Workers, `echo-grid-feedback-web`, **Metrics**: CPU time (median and 99th percentile) per Worker **version**, comparing the active version before `f2ae60ee` with `f2ae60ee`.
2. **Settings**: the Workers plan, and whether a CPU limit (`limits.cpu_ms`) applies.
3. Workers Logs for Ray ID `a59ddbd89edbb903` and the request count over the window.
4. Optional, low-risk reproduction: a controlled burst of about 50 requests to the staging landing page while watching staging Observability. Staging runs the same code on the same account, so it should show the same limit if H1 or H2 is true. NOT TESTED.

## 7. Minimal remediation plan (PROPOSED, NOT IMPLEMENTED)

Chosen by the confirmed cause:

- **If plan-limited (H1):** raise the plan or CPU limit (a billing decision for the owner), then redeploy the same code to staging first and run the burst test. No code change.
- **If cold-start or per-request cost is the driver (H2):** reduce work per request, for example avoid loading all message namespaces per request where not needed, serve the landing page without per-request cookie work where safe, and measure again with the same local harness before any release.
- **In every case:** no speculative fix reaches production. Each change is measured old versus new with the harness above and a staging burst test.

## 8. Regression test plan (PROPOSED, NOT IMPLEMENTED)

- A repeatable CPU-per-request measurement in CI or pre-release (the local workerd harness), failing when a page exceeds an agreed budget or grows more than an agreed percentage against the last production release.
- A post-deploy production watch for 30 minutes: error rate and CPU p99 per Worker version, with an automatic go-back criterion.
- Keep the existing browser tests; note that `e2e/dialog-theme.spec.ts` failed once on a docs-only PR and passed on re-run, which may indicate a timing weakness worth a separate look.

## 9. Rollback and recovery

- Fastest: Cloudflare dashboard rollback of the Web Worker to the previous version (used on 2026-11-13; effective, no code change).
- Repeatable, recorded: the web-only workflow deploys only the current tip of `main`, so rolling back to an older commit through GitHub needs a revert merged to `main` first. Dashboard rollback is therefore the practical emergency tool; each use should be written into the release log.

## 10. Web and API compatibility (Old Web with new API)

Assessed by diffing API route files between the previous production API (`2b265289`, 2026-11-10) and `532e65c4`:

- No route was removed. Routes were added (customer language, messaging unread counts, customer lookup actions) or had their permission changed.
- The D-C1 permission changes (`loyalty:serve`, `loyalty:accounts:view`, `loyalty:adjust`) apply to the same endpoints the old Web already calls. Owner, Admin and Manager roles hold both the old and the new permissions, so they are unaffected.
- **Staff (cashier) roles** now hold only `business:view`, `branches:view` and `loyalty:serve`. The old Web may still show Staff navigation items for feedback, loyalty pages and messages; those requests are now refused by the API. Expected effect: "not available with your current access" messages, not data exposure. NOT TESTED against the old Web build.
- Database changes (`0067`, `0068`) are additive and unused by the old Web.
- New Web with the current API: compatible by construction (staging runs it).
  Verdict: **old Web with new API is compatible for normal use; Staff users may see refused pages.** NOT TESTED end to end.

## 11. Open items

- Active production Web version after the rollback: UNVERIFIED.
- Root cause: UNKNOWN.
- Production CPU metrics and plan: BLOCKED on owner access to Cloudflare.
