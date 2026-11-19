# CASHIER-AUTH-02E E2 follow-up: mailbox integration and live-acceptance readiness (2026-11-19)

Status: **development complete when merged; live staging acceptance NOT run and BLOCKED by owner approvals.** Baseline: `main` @ `041b444` (PR #529 merged). Production untouched. Nothing here sets an approval.

## 1. Provider discovery (what the repository actually has)

| Question | Finding |
|---|---|
| Mail delivery provider | **Resend**, through the `EmailService` abstraction (`apps/api/src/notifications/email.service.ts`, `ResendEmailService`, secret `RESEND_API_KEY` on the API Worker). Staging sender `RESEND_FROM_ADDRESS`. |
| Customer registration message | An **email confirmation link**, not a code: `<web>/loyalty/signup/verify#c=<challengeId>.<proof>` (`customer-email-auth.delivery.ts`, 15 minute lifetime). The proof is in the URL **fragment**, with no query, and is never logged. SMS verification is a separate, later flow. |
| Existing test mailbox for READING mail | **None.** No approved provider, inbox, address or domain for receiving test mail exists. The existing customer email-auth Playwright spec has the operator supply the link out of band. |
| Secret conventions | Names only in documents; values entered by the owner (`wrangler secret put`); nothing committed. The harness follows this: credentials come only from environment variables, and a missing one is reported by name. |
| Feature flag | `CUSTOMER_EMAIL_AUTH_ENABLED = "true"` in both Workers' staging templates (`apps/api/wrangler.toml`, `apps/web/wrangler.toml`), while `docs/runbooks/CUSTOMER_EMAIL_AUTH_STAGING.md` still says `"false"` (stale text). The flag on the **deployed** staging Workers is **NOT VERIFIED** (reading it needs a request to staging, which is not authorised here). |

**Why the existing provider is not simply read back.** The provider's sent-mail listing, as used by earlier staging runs through the Resend tool, is account-wide: finding one recipient's message would mean reading the metadata of unrelated messages,
which is the generic inbox crawling this work forbids. (To be confirmed against the provider's documentation before any adapter is built.) Options for the owner: (a) a dedicated provider account or domain used only for acceptance, with a read-only key, so a listing contains only acceptance mail; (b) a dedicated
receiving address or webhook that supports lookup by exact recipient; (c) an operator-supplied export, which the provider-neutral adapter supports today. **No provider was chosen and none is contacted.**

## 2. Defect found and fixed during discovery

The E2-B validator required a link with a query string and refused any fragment, so it would have **rejected every real confirmation link**. It now accepts exactly the application's format
(`https`, the approved web host, path `/loyalty/signup/verify`, no query, fragment `#c=<uuid>.<64 hex>`), imports the path from the code that builds the link, and its tests build links with the application's own generator and refuse the old query style.

## 3. What was implemented

- **Provider-neutral adapter `local-spool`** (`adapters/local-spool.ts`), registered as the only adapter in `adapters/index.ts`. It reads one file per recipient, `<sha256(recipient)>.json`, from `ACCEPTANCE_MAILBOX_SPOOL_DIR`: never lists or globs the directory, refuses symbolic links out of it, non-files and files over 64 KiB, and names no content in any error.
  Everything else is enforced for every adapter by `RestrictedVerificationMailbox`: exact approved recipient bound to the run, fresh-only, a foreign-recipient message is refused, link host/path/fragment validation, size limits.
- **Evidence without sensitive content:** the mailbox keeps only a 12 character recipient hash, the purpose, `link` or `code`, the message age and the adapter name. No link, proof, address or message is stored (tested).
- **Separate live-execution authorization:** `staging-targets.json` gains `liveExecution { authorized, authorizedBy, reference }` (shipped false). A live run needs the hostnames approved **and** this.
- **Readiness preflight** (`preflight.ts`, `pnpm acceptance:cashier-02 -- --preflight [--online]`): 15 prerequisites, each PASS, BLOCKED or NOT VERIFIED; offline unless both approvals are recorded and `--online` is given; exit 0 READY, 2 something BLOCKED, 4 nothing blocked but a required item NOT VERIFIED. Prints names and reasons, never values.
- Redaction no longer hides public staging host names (the owner must be told exactly which hosts to approve); long secrets are still redacted.

## 4. Staging host allow-list assessment

| Role | Hostname in `staging-targets.json` | Worker (Cloudflare metadata, read only) | Repository configuration |
|---|---|---|---|
| API | `echo-grid-feedback-api-staging.katohuzairu122.workers.dev` | `echo-grid-feedback-api-staging` exists, last modified 2026-11-19T04:46Z | `name = "echo-grid-feedback-api-staging"`; the web Worker's `API_BASE_URL` |
| Web | `echo-grid-feedback-web-staging.katohuzairu122.workers.dev` | `echo-grid-feedback-web-staging` exists, last modified 2026-11-19T04:46Z | `ALLOWED_ORIGINS` and the staging web configuration |
| Cashier | `echo-grid-feedback-cashier-staging.katohuzairu122.workers.dev` | `echo-grid-feedback-cashier-staging` exists, last modified 2026-11-19T04:46Z | `CASHIER_HOST` of `[env.cashier-staging]` |

The three configured hostnames match the repository's Worker configuration (a unit test and preflight item P03 check it) and the three Workers exist. The `katohuzairu122.workers.dev` account subdomain is taken from that configuration and was not independently queried. **Not verified:** that the hostnames resolve and answer (`/health`), because no request is made to a host the owner has not approved.
The staging Workers were last deployed from `fe9c5e8`, before PRs #525 to #529; the harness is a script and does not depend on that, but staging does not yet contain the branch-deletion session revocation (#525).
**Exact approval needed:** the three hostnames above. Production names (`echo-grid-feedback-api`, `-web`, `-cashier` without `-staging`, and `*.echo-grid.uk`) remain refused.

## 5. Customer provisioner validation

| Requirement | Where it is met | Verified how |
|---|---|---|
| 1 Real sign-up through the trusted web Worker | `signup-driver.ts` drives `/loyalty/signup` on the approved web host in a browser | **Not exercised live** (needs approvals) |
| 2 Confirmation link from the approved mailbox | `LiveCustomerProvisioner` + `RestrictedVerificationMailbox` | unit tests and a mock-backed run; link format now locked to the real generator |
| 3 Password setup | driver `completeSignup` (random in-memory password, never printed) | unit tests (fake driver) |
| 4 Customer sign-in | driver `signIn` (real sign-in page, token from the session cookie) | not exercised live |
| 5 Real customer consent | The email sign-up has no consent step; consent is the explicit `JOIN_LOYALTY` consent at the cashier invitation (S04), enforced by the API | integration tests and the local browser run |
| 6 Cashier-assisted acceptance | scenarios S03 to S05, S10 to S12 | integration tests against the real application |
| 7 Returning customer | `returning()` and S15 | integration tests |

No database insert, no bypass of confirmation, SMS or authentication, no real customer identity (only `acc-<run>-<label>@<approved domain>`), and no cleanup method exist in the live path (tested). Phone-verified customers stay NOT RUN (a real SMS code is required).

## 6. Owner approvals required (exact edits, each a reviewed commit)

1. Hostnames: `approved: true`, `approvedBy`, `approvedAt` in `staging-targets.json`.
2. Mailbox: provider decision (section 1), then `mailbox.approved: true`, `approvedBy`, `adapter` (a name registered in `adapters/index.ts`; `local-spool` works today), and `allowedRecipientDomains`. A provider adapter is a separate block.
3. Customer provisioning: `customerProvisioning.approved: true`, `approvedBy`.
4. Live execution: `liveExecution.authorized: true`, `authorizedBy`, `reference` (a separate directive).
5. Environment for the run (names only): `ACCEPTANCE_OWNER_{A,B}_{EMAIL,PASSWORD,BUSINESS_ID}` (business A with at least three branches, business B at least one) and the adapter's own variables (`ACCEPTANCE_MAILBOX_SPOOL_DIR` for `local-spool`).
Still open and not touched: D1 attribution secret, D2 retention and erasure, D3 deliberate lockout, D6 release bundle.

## 7. Preflight result for the shipped configuration (offline)

BLOCKED: P01 hostnames not approved, P04 live execution not authorized, P05 no mailbox, P08 no synthetic recipient domain, P09 customer provisioning not approved, P10 staging owner credentials not set (in this environment).
PASS: P02 no production host, P03 hostnames match the repository Worker configuration, P12 sign-up driver present.
NOT VERIFIED: P06 and P07 (depend on P05), P13 and P14 (no request is made to unapproved hosts), P15 `CLIENT_ATTRIBUTION_SECRET` presence (advisory, D1, cannot be read by the harness).
P11 browser automation: BLOCKED in this container unless `E2E_CHROMIUM_PATH` points at the pre-installed Chromium (then PASS). **Verdict: NOT READY (exit 2).**

## 8. Remaining gaps and dependencies

No real mailbox read, no real sign-up and no live run yet; phone-verified scenarios and live expiry stay NOT RUN. E3 needs D3. E4 needs D1, D2, D6.
