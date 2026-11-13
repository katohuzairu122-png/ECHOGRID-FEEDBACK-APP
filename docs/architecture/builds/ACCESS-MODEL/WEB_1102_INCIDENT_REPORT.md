# WEB-1102: production Web Worker CPU-limit incident (read-only investigation)

**Status (updated 2026-11-13 evening): root cause identified (Workers Free 10 ms CPU limit); fix (Workers Paid plus Web redeploy) verified on a small sample, see sections 10a and 10b. The text below the status updates is the original investigation record and still says the cause was not found; read sections 10a and 10b first. This document itself deployed, rolled back and changed nothing.**
Written 2026-11-13 from GitHub run records, the repository at `main` `532e65c4`, the owner's Cloudflare Observability screenshot, and local measurements. Labels: VERIFIED, PROPOSED, BLOCKED, NOT IMPLEMENTED, NOT TESTED.

## 1. Verdict

**Release verdict: NO-GO for any production Web deploy until the plan question below is resolved and a staging burst test passes.**
**Most likely cause (supported by owner-supplied Cloudflare evidence, section 4.5): the account is on the Workers Free plan, whose limit is 10 ms of CPU per request, and this application's median request already costs more than that.** The newer release raised the error rate, but the older release also hit the limit. The API and database changes are separate and remain in place.

## 2. Verified timeline (UTC)

| When              | Event                                                                                                                                                                                                                                                                                                                    | Source                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 2026-11-12 04:11  | Production web-only deploy of `b2f85ac0` succeeded (run 43153114639). Last web release before the incident.                                                                                                                                                                                                              | GitHub run record: VERIFIED                       |
| 2026-11-13 11:52  | Production migrations `0067` and `0068` applied (run 43420468101).                                                                                                                                                                                                                                                       | VERIFIED                                          |
| 2026-11-13 12:02  | Production release run 43421810874 started on `main` `532e65c4`.                                                                                                                                                                                                                                                         | VERIFIED                                          |
| 12:15 to 12:16    | API deployed (success).                                                                                                                                                                                                                                                                                                  | VERIFIED                                          |
| 12:22 to 12:23:53 | **Web deployed** (success); post-deploy checks 2E to 2H passed.                                                                                                                                                                                                                                                          | VERIFIED                                          |
| from about 12:24  | Cloudflare Observability shows "Worker exceeded CPU time limit" on `echo-grid-feedback-web`, script version `f2ae60ee`, on `GET /` and `GET /dashboard`. Red bars on the chart from about 12:33; log rows visible 12:42:51 to 12:48:27.                                                                                  | Owner screenshot: VERIFIED as reported            |
| 12:42:51          | Owner reports Error 1102 on echo-grid.uk, Ray ID `a59ddbd89edbb903`.                                                                                                                                                                                                                                                     | Owner screenshot                                  |
| after 12:48       | Owner reported rolling the web Worker back and the errors stopping. **No rollback is recorded**: the Deployments tab (about 15:20 UTC) lists `f2ae60ee` as the newest and active deployment at 100% of traffic. The errors most likely only appeared to stop because traffic is very low (0 to 0.1 requests per second). | Owner report; Deployments and Metrics screenshots |

The errors begin within about a minute of the web deploy finishing.

## 3. Versions

| Item                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                       | Status                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Impacted Web           | `main` `532e65c4`, Worker version `f2ae60ee`                                                                                                                                                                                                                                                                                                                                                                                                | VERIFIED (run record and Observability)     |
| Current production API | `532e65c4` (deployed 12:16 UTC)                                                                                                                                                                                                                                                                                                                                                                                                             | VERIFIED                                    |
| Current production Web | **`f2ae60ee` at 100% of traffic (the failing release, `main` `532e65c4`).** The Cloudflare Deployments tab shows it as the newest entry, "Manually deployed by API token", about 3 hours before the screenshot, with **no rollback or later deployment listed**. Older versions below it: `b3ef5ec8` (1 day earlier), `8826f2a8`, `39baef52` and so on. Active-deployment row: error rate 3.7%, median CPU 19.21 ms, 0 requests per second. | **VERIFIED** (owner Deployments screenshot) |
| Production database    | migration 69 of 69 (`0068`), Phase A and B role grants applied                                                                                                                                                                                                                                                                                                                                                                              | VERIFIED                                    |

Next diagnostic action: the owner reads the active Web version id and its deployment date in Cloudflare (Workers, `echo-grid-feedback-web`, Deployments) and confirms it matches the `b2f85ac0` build.

## 4. Evidence

**Observed (owner screenshot, VERIFIED as reported):** the error is the CPU execution limit ("Worker exceeded CPU time limit"; Cloudflare page "Error 1102, Worker exceeded resource limits"), not a wall-clock, memory or other exception. It affects the public landing page as well as the dashboard, so it is not specific to one feature.

### 4.1 Local measurement method (VERIFIED, NOT a production measurement)

I built the Worker at `b2f85ac0` (old) and `532e65c4` (new) and ran each in Cloudflare's local runtime (workerd) against the **same new API and a throwaway PostgreSQL 16 with all 69 migrations** (which is the current production combination: old Web with new API). CPU is the sum of CPU time of both runtime processes that `wrangler dev` starts (a proxy and the process that runs the Worker). Requests were made from a signed-in browser session with the cache bypassed. Each figure is the average over 20 warm requests; each build was run 4 times, alternating, and the table shows the median and range. CPU time is read in 10 ms ticks, so single numbers are good to about 1 ms only after averaging.

**Correction recorded:** the first signed-in harness I wrote counted only the proxy process and under-reported CPU by about 7x. I found the error by listing the processes, fixed it, and discarded those numbers. The figures below use the corrected method. The signed-out figures in the earlier version of this report (summing all runtime processes) agree with it.

### 4.2 Result: warm CPU per request, median of 4 runs (ms)

| Page                     | Old  | New  | Difference                                              |
| ------------------------ | ---- | ---- | ------------------------------------------------------- |
| `/` signed out           | 50.8 | 51.2 | +0.5                                                    |
| `/login`                 | 28.5 | 29.5 | +1.0                                                    |
| `/privacy`               | 26.5 | 24.2 | -2.2                                                    |
| `/` signed in (redirect) | 31.2 | 34.0 | +2.8                                                    |
| `/dashboard`             | 38.5 | 44.2 | **+5.8** (ranges 36 to 40 vs 41 to 46, not overlapping) |
| `/dashboard/feedback`    | 38.2 | 38.8 | +0.5                                                    |
| `/dashboard/loyalty`     | 38.2 | 34.8 | -3.5                                                    |
| `/dashboard/messages`    | 30.2 | 33.0 | +2.8                                                    |
| `/dashboard/settings`    | 28.0 | 31.8 | +3.8                                                    |

First request after start (cold), `/`: old 130 to 160 ms, new 110 to 160 ms. Main server bundle: 7.39 MB (old) to 7.56 MB (new), +2.3%.

### 4.3 What the measurements say

1. **Public pages are equal old versus new.** No regression in the landing, login or privacy pages.
2. **Signed-in pages are slightly higher on the new build** (about 1 to 6 ms, up to about 15%); only `/dashboard` home is consistently higher. Not enough to explain a failure that did not occur with the old build, unless the account sits close to its limit.
3. **Every request is expensive, old and new:** about 25 to 50 ms locally even for a plain redirect, and 110 to 160 ms for the first request after a cold start. That large fixed cost per request is the dominant factor, and it was already present in the old release.
4. **Profile (new build, unminified wrapper, 40 warm requests to `/privacy`):** CPU is spread across the Next.js and React server runtime and OpenNext's request handling, with no single hot spot. Request routing in the OpenNext layer (route pattern compilation and matching) is visible at roughly a tenth of the Worker's own CPU. The Next.js server code itself is pre-minified by Next, so its functions cannot be named.

Caveats: this sandbox is not the Cloudflare edge, so absolute numbers do not transfer; only the old-versus-new comparison does. Production CPU metrics, the real plan and real production data were **not available** to me. The local database holds no production data.

### 4.4 What is NOT supported by the evidence

- "The new release made pages much heavier": **not supported** (section 4.2).
- "The unread-badge polling caused it": **not supported** for these errors, because `/` does not run it. Polling remains a possible traffic contributor and is NOT TESTED under load.
- OpenNext, Next.js and authentication middleware were not shown responsible. The Worker runs Next.js in minimal mode (`NEXT_PRIVATE_MINIMAL_MODE`), which skips the Next.js middleware file; layouts perform their own session checks.

### 4.5 Production evidence supplied by the owner (Cloudflare dashboard screenshots, 2026-11-13)

Read from screenshots of Metrics (last 24 hours), the Workers plans page and the Observability page. The images are small; figures marked "unclear" could not be read reliably.

| Item                        | Value                                                                                                              | Status                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Account plan                | **Workers Free** (Observability banner: "You're on Workers Free ... 200K events per day")                          | VERIFIED                                                |
| Free plan CPU limit         | **10 ms per request** (plans page); Paid is $5 per month with a far higher CPU allowance                           | VERIFIED                                                |
| Errors by type, 24 h        | **Exceeded CPU Time Limits: 23**; Exceeded Memory: 0; Internal: 0                                                  | VERIFIED                                                |
| Invocations by version      | `b3ef5ec8` (older): about 3,000; `f2ae60ee` (this release): 388                                                    | VERIFIED                                                |
| Errors by version           | `b3ef5ec8`: 8; `f2ae60ee`: 15                                                                                      | VERIFIED                                                |
| Error rate                  | `b3ef5ec8` about 0.3%; `f2ae60ee` 3.9% (about 14 times higher; small sample on the newer version)                  | VERIFIED, derived                                       |
| Median CPU time, `f2ae60ee` | **16.88 ms**, above the 10 ms Free limit                                                                           | VERIFIED                                                |
| CPU Time chart legend       | P50 104, P90 259, P99 421, P999 465 over 24 h; units and scope unclear and not consistent with the 16.88 ms figure | UNCLEAR                                                 |
| Memory                      | median about 36 MB, 99th percentile about 48 MB                                                                    | VERIFIED (not a memory problem)                         |
| Active deployment           | `f2ae60ee`, 100% of traffic, deployed about 2 h earlier, 0.1 requests per second                                   | VERIFIED, **conflicts with the reported rollback**      |
| Subrequests by host         | API host: 589 successful and 279 with an orange (non-2xx) chip; `echo-grid.uk`: 11                                 | PARTLY UNCLEAR: the 279 needs identifying (status code) |
| Workers Traces              | Disabled                                                                                                           | VERIFIED                                                |

What this means:

- The **Free-plan 10 ms limit is verified**, and the median request on the new version (16.88 ms) is above it. This strongly supports hypothesis H1.
- The **older version also produced CPU-limit errors** (8, including a burst of several at once the evening before), so the limit was already being hit before this release. The new release made it about 14 times more frequent in this sample.
- My local measurements (sections 4.2 and 4.3) fit this: the old and new builds cost nearly the same, and the new build is a little heavier on signed-in pages. A small increase against a limit that is already too low raises the error rate sharply.
- **The failing version is still live.** The Deployments tab confirms `f2ae60ee` is active at 100% of traffic with no rollback. Upgrading the plan would therefore fix it immediately, with no redeploy.

## 5. Bounded hypotheses (none confirmed)

| #   | Hypothesis                                                                                                                                                                                                             | For                                                                                                               | Against / unknown                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| H1  | The account's Workers plan has a low CPU limit (for example the Free plan's 10 ms per request) and every page sits near it, so a small increase (the new dashboard is up to about 15% higher) tips some requests over. | Every request costs a large fixed amount, even a redirect; no `limits.cpu_ms` is set in `apps/web/wrangler.toml`. | The old release served traffic for days under the same limit. The real edge CPU per request is unknown to me.  |
| H2  | Cold-start work (initialising a 7.5 MB server bundle) exceeds the limit when isolates are recycled, which happens after every deploy.                                                                                  | First request costs 110 to 160 ms locally; the errors began within a minute of the deploy.                        | Old and new cold costs are about equal locally.                                                                |
| H3  | A runaway or very slow code path that only occurs with production data or state, burning CPU until the limit.                                                                                                          | A Paid-plan limit is far higher than these pages need, so errors on `/` would then need a loop.                   | No loop was found; the same code is clean locally and on staging smoke tests. NOT TESTED with production data. |
| H4  | A Cloudflare-side or account-side event around 12:24 UTC coincided with the deploy.                                                                                                                                    | A rollback also changes the isolate set.                                                                          | No evidence either way.                                                                                        |

**Status after section 4.5:** H1 (plan CPU limit) is **supported by verified evidence**. H2 (cold-start cost) remains possible and compounds H1. H3 (a runaway path with production data) is now **unlikely**: the median CPU is modest relative to a Paid limit and the errors are the plain limit message with memory fine. H4 (a Cloudflare-side event) is not supported, because the older version also errored.

## 6. Evidence still needed (read-only, owner side) and how each result decides the path

1. Cloudflare, Workers, `echo-grid-feedback-web`, **Settings**: the Workers **plan** and whether a CPU limit applies.
2. **Metrics**: CPU time (median and 99th percentile) per Worker **version**, comparing the active version before `f2ae60ee` with `f2ae60ee`, and the request count over the window.
3. **Workers Logs** for Ray ID `a59ddbd89edbb903`: the CPU and wall time recorded on erroring invocations.
4. Optional reproduction: a controlled burst of about 50 requests to the staging landing page while watching staging Observability (same code, same account).

**Decision tree**

- Plan is **Free** (or a CPU limit near 10 ms): H1 is likely. **THIS BRANCH APPLIES (verified Free plan).** Move to a plan with a higher CPU limit, then redeploy the same code to staging first and run the burst test. Optional later work: cut per-request cost (section 7).
- Plan is **Paid** and the erroring invocations show CPU close to the maximum: H3, a runaway path. Find the request in Workers Logs, reproduce it locally with the same inputs, fix, and add a regression test.
- Plan is **Paid** and CPU per request is modest: H4 or a deploy-time effect; re-deploy to staging, observe, and compare versions before any production attempt.

## 7. Minimal remediation plan (PROPOSED, NOT IMPLEMENTED)

- **Decided by the evidence above; no speculative fix reaches production.** Each change is measured old versus new with the harness in Appendix A and a staging burst test before any production attempt.
- **Plan or limit (if H1):** a billing decision for the owner, no code change.
- **Per-request cost (optional, any hypothesis):** reduce fixed work per request, for example avoid loading every message namespace on pages that need few, avoid per-request route-pattern compilation where configuration allows, and keep public pages free of cookie-dependent rendering where safe. Each is a separate, measured change, not a bundle.
- **Do not redeploy the Web release** until one path above is confirmed and a staging burst passes.

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

## 10a. Status update, 2026-11-13 evening

| Item                                             | Finding                                                                                                                                                                                                                                                                                                                                                                | Status                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Workers plan                                     | **Workers Paid is subscribed** (Cloudflare Subscriptions page, owner screenshot 2026-11-13 about 17:10 UTC: "Workers Paid, renews on Dec 11, 2026"). The default CPU limit is therefore 30 seconds, not 10 ms.                                                                                                                                                         | **VERIFIED**                                                               |
| Owner action: rollback                           | Reported, but a Metrics screenshot at about 16:45 UTC still showed `f2ae60ee` at 100% of traffic, so **no rollback was applied** before the redeploy.                                                                                                                                                                                                                  | Conflicting; superseded by the redeploy below                              |
| Production Web-only release                      | Run 43465438302 on `main` `846fea9b` **succeeded** at 16:56 UTC: CI gate, tested artifact, environment approval, deploy, and its own post-deploy checks (deployed version at 100%, HTTP 200, API deployment unchanged). The Worker's last-modified time is 16:56:43 UTC. The code is the same as `f2ae60ee` (only documentation differs), now as a new Worker version. | VERIFIED                                                                   |
| Active version and error rate after the redeploy | Deployments tab (about 17:10 UTC): **`3087cbd8` active at 100% of traffic, deployed about 13 minutes earlier, error rate 0%, 0 requests per second**; `f2ae60ee` is listed below it. Traffic is too low for the 0% to prove anything yet.                                                                                                                              | VERIFIED active version; error behavior **NOT YET OBSERVED under traffic** |
| Docs check                                       | Free plan CPU is 10 ms per request; Paid is 30 seconds by default. Isolates have limited leeway for occasional overage. Cloudflare says server-rendered apps usually need Paid.                                                                                                                                                                                        | VERIFIED against Cloudflare documentation                                  |

**Block 0 remains open, with two of three conditions met:** the plan is Paid (verified) and the new version is active (verified). Still needed: a clean observation window under real traffic (Metrics, last 30 minutes, "Errors by type" showing no "Exceeded CPU Time Limits"). A short burst of requests to the public site, or normal use of the dashboard, will provide it.

## 10b. Observation under traffic, 2026-11-13 about 17:45 UTC (owner screenshots)

Metrics for `echo-grid-feedback-web`, filter "Specific versions (1)" = `3087cbd8`, range "Last 6 hours", version deployed about 49 minutes earlier at 100% of traffic:

| Item                          | Finding                                                                                                                  | Status   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| Errors (version `3087cbd8`)   | **0** (Errors card). Error rate on the Active deployment card: 0%.                                                       | VERIFIED |
| Invocations (`3087cbd8`)      | 62 in the window (other versions in the same window: `f2ae60ee` 428, `b3ef5ec8` 14).                                      | VERIFIED |
| Asset requests (all versions) | 4xx 0, 5xx 0.                                                                                                            | VERIFIED |
| Per-version error panels      | The "Errors by invocation status" legend was not captured; the filtered Errors card (0) is the evidence used.            | LIMITATION |

**Conclusion:** on Workers Paid, version `3087cbd8` shows no errors over 62 invocations. The sample is small and the window is short, so this is evidence the fix works, not a long-run guarantee. **Recommendation:** owner may certify Block 0 as resolved; keep watching the Errors card during normal use.

**Open observation (not an incident):** CPU time per request is not understood. The CPU Time card for `3087cbd8` showed 103 ms, while the Active deployment card showed a median of 288 ms (24 h, all-version view) and 416.3 ms (6 h). These disagree with each other and with the local warm measurement of about 17 to 19 ms. Likely causes (unconfirmed): cold-start initialisation counted in a small sample, and different aggregations (median versus other). With a 30 second limit this cannot reproduce Error 1102, but Paid bills CPU time, so it should be re-read under steady traffic and investigated if it persists.

## 11. Open items

_Items below were written before the upgrade and redeploy; where they conflict with section 10a, section 10a is current._

- **Owner decision:** upgrade the Cloudflare account to Workers Paid (a billing decision; about $5 per month plus usage), which raises the CPU limit far above this application's needs. If the failing version is still live, errors should stop at once without a redeploy. This also applies to the API Worker on the same account.
- **Interim option if the upgrade cannot happen today:** a real rollback of the Web Worker (Deployments tab, the "..." menu on `b3ef5ec8`, then roll back). Note the older version also produced CPU-limit errors (0.3% in the sample), so a rollback reduces but does not remove the problem, and it withdraws today's Web features until the plan is raised.
- **Active Web version: VERIFIED as `f2ae60ee` (the failing release), not rolled back.** Real users on the public site see CPU-limit errors on about 3.7% of requests until the plan is raised or a real rollback is applied.
- **Owner to identify** the orange (non-2xx) chip on 279 subrequests to the API host (the status code), and read the CPU Time chart legend units.
- Root cause: **LIKELY (plan limit), not fully confirmed** until a staging burst test after the upgrade passes.
- After the upgrade: redeploy the Web release to staging, run a controlled burst (about 50 requests) and watch Errors by version, then a separate authorization for production.
- Optional later work: reduce per-request CPU (section 7), so the application is not close to any limit.

## Appendix A: reproducing the measurement (read-only, local)

Prerequisites: PostgreSQL 16 on a throwaway port with a role `echogrid` / password `echogrid`, the repository migrated and the permission catalog seeded (`pnpm --filter @echo-grid-feedback/api db:migrate` and `db:seed` with `DATABASE_URL` pointing at it), the API running with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` set to that local database and `wrangler dev --local --port 8787`, and each Web build produced with `pnpm exec opennextjs-cloudflare build`. **Never point these at production or staging databases.** The script starts the Web Worker, signs up a throwaway user in a browser, then measures CPU. Run it once per build and compare medians over several runs: `node signed.mjs <apps/web dir> <port> <label> 20`.

```js
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('/home/user/p1/apps/web/package.json');
const { chromium } = require('@playwright/test');
const [dir, port, label, N = '20'] = [
  process.argv[2],
  +process.argv[3],
  process.argv[4],
  +(process.argv[5] || 20),
];
const HZ = +execSync('getconf CLK_TCK').toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}`;
const p = spawn(
  'pnpm',
  [
    'exec',
    'wrangler',
    'dev',
    '--local',
    '--port',
    String(port),
    '--var',
    'API_BASE_URL:http://127.0.0.1:8787',
    '--var',
    `APP_URL:${base}`,
    '--show-interactive-dev-session=false',
  ],
  {
    cwd: dir,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: 'ignore',
    detached: true,
  },
);
function webCpu() {
  // CPU ticks of ALL workerd processes in THIS wrangler instance's process group (proxy + user worker)
  const out = execSync('ps -eo pid,pgid,args')
    .toString()
    .split('\n')
    .filter((l) => l.includes('workerd serve') && l.trim().split(/\s+/)[1] == String(p.pid));
  let tot = 0;
  const pids = [];
  for (const l of out) {
    const pid = l.trim().split(/\s+/)[0];
    try {
      const f = require('node:fs')
        .readFileSync(`/proc/${pid}/stat`, 'utf8')
        .split(')')
        .pop()
        .trim()
        .split(/\s+/);
      tot += +f[11] + +f[12];
      pids.push(pid);
    } catch {}
  }
  return { tot, pids };
}
let browser;
try {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(`${base}/robots.txt`);
      break;
    } catch {
      await sleep(1000);
    }
  }
  await sleep(2000);
  browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const doGet0 = (path) =>
    page.evaluate(async (p) => {
      const r = await fetch(p, { redirect: 'manual', credentials: 'include', cache: 'no-store' });
      await r.text();
      return r.type === 'opaqueredirect' ? 'redirect' : r.status;
    }, path);
  const measure = async (path) => {
    const t0 = webCpu().tot;
    await doGet0(path);
    await sleep(300);
    const t1 = webCpu().tot;
    const a = webCpu().tot;
    const walls = [];
    const codes = new Set();
    for (let i = 0; i < N; i++) {
      const t = Date.now();
      const st = await doGet0(path);
      walls.push(Date.now() - t);
      codes.add(st);
    }
    await sleep(500);
    const b = webCpu().tot;
    return {
      status: [...codes].join('/'),
      firstCpuMs: Math.round(((t1 - t0) * 1000) / HZ),
      warmCpuMsPerReq: +(((b - a) * 1000) / HZ / N).toFixed(1),
      wallMsAvg: Math.round(walls.reduce((x, y) => x + y, 0) / N),
    };
  };
  const u = Date.now();
  await page.goto(`${base}/signup`);
  await sleep(1500);
  const signedOut = {};
  for (const path of ['/', '/login', '/privacy']) signedOut[path] = await measure(path);
  await page.getByLabel('Full name').fill('Cpu Probe');
  await page.getByLabel('Email').fill(`cpu-${label}-${u}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('a-strong-test-password');
  await page.getByLabel(/I agree to the Terms of Service/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill(`Probe ${u}`);
  await page.getByLabel('URL slug').fill(`probe-${label}-${u}`);
  await page.getByRole('button', { name: 'Create business' }).click();
  await page
    .getByRole('heading', { name: 'Business Overview', exact: true })
    .waitFor({ timeout: 60000 });
  await sleep(1500);
  const paths = [
    '/',
    '/dashboard',
    '/dashboard/feedback',
    '/dashboard/loyalty',
    '/dashboard/messages',
    '/dashboard/settings',
  ];
  const doGet = (path) =>
    page.evaluate(async (p) => {
      const r = await fetch(p, { redirect: 'manual', credentials: 'include', cache: 'no-store' });
      await r.text();
      return r.type === 'opaqueredirect' ? 'redirect' : r.status;
    }, path);
  const result = { label, workerdPids: webCpu().pids.length, signedOut, paths: {} };
  for (const path of paths) {
    const t0 = webCpu().tot;
    await doGet(path);
    await sleep(300);
    const t1 = webCpu().tot;
    const a = webCpu().tot;
    const walls = [];
    const codes = new Set();
    for (let i = 0; i < N; i++) {
      const t = Date.now();
      const st = await doGet(path);
      walls.push(Date.now() - t);
      codes.add(st);
    }
    await sleep(500);
    const b = webCpu().tot;
    result.paths[path] = {
      status: [...codes].join('/'),
      firstCpuMs: Math.round(((t1 - t0) * 1000) / HZ),
      warmCpuMsPerReq: +(((b - a) * 1000) / HZ / N).toFixed(1),
      wallMsAvg: Math.round(walls.reduce((x, y) => x + y, 0) / N),
    };
  }
  console.log(JSON.stringify(result, null, 1));
} catch (e) {
  console.log('ERROR', e.message.split('\n')[0]);
} finally {
  try {
    await browser?.close();
  } catch {}
  try {
    process.kill(-p.pid, 'SIGTERM');
  } catch {}
}
```
