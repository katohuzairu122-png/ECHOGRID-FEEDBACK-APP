# CASHIER-PWA-01 block C1: development preflight (read-only inspection, no changes)

**Status: C1 RECORD. Read-only inspection and documentation only. No application code, database, Cloudflare resource, secret, DNS record or Worker was changed or created; nothing was merged or deployed; C2 is not started. Financial activation remains NO-GO. The WEB-1102 production restriction is unchanged (Block 0 is not certified).**
Baseline: `main` `bbe3c4c8` (after PR #416 merged). PR #416: merged. PR #417 (cashier decision record): open, draft, still based on the old design branch (no hosted CI runs for it). Labels: **VERIFIED**, **PROPOSED**, **UNKNOWN**.

## 1. Owner decisions carried into this preflight (2026-11-14)

Hostname `cashier.echo-grid.uk`; separate cashier origin and **dedicated Worker**; same business accounts, staff identities, memberships and database; independent cashier sessions; existing API-enforced permissions; no cashier access to administrative endpoints; **no device PIN and no mandatory enrollment in the initial release**.

## 2. Feasibility verdict

**FEASIBLE. No locked security contract conflicts with the architecture, so there is no stop condition.** Three existing contracts constrain how it must be built and are listed in section 7: the deployment-governance test (only listed workflows may deploy), the web-only release tool (pins one Worker, domain and "no resource bindings"), and the refresh-token reuse rule (a replay revokes every session of the user). C2 can be authorized as scoped in section 9.

## 3. Authentication, cookie and session findings

| Topic              | Finding                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookies            | **VERIFIED.** `ff_access_token` (15 min) and `ff_refresh_token` (30 days) are httpOnly, `SameSite=lax`, `Path=/`, **no `Domain`**, so they are host-only. A second hostname never receives them.                                                                                                                                                                                                                       |
| Access token       | **VERIFIED.** HS256 JWT with `sub`, `type: access`, optional `impersonatedBy`, optional signed session id `sid` (validated against a session-id pattern), `iat`, `exp`. No client type or business binding exists. `verifyAccessToken` rejects non-access tokens and malformed `sid`.                                                                                                                                  |
| Refresh rotation   | **VERIFIED.** Each refresh issues a new pair inside the **same** session id and links the old row (`replacedByTokenId`). A concurrent-refresh grace window returns `REFRESH_TOKEN_ROTATED`. Account status is re-checked on every rotation.                                                                                                                                                                            |
| Reuse detection    | **VERIFIED.** A replay of an already-rotated token outside the grace window calls `revokeAllForUser`: **every session of that user is revoked, including an admin session on another origin.**                                                                                                                                                                                                                         |
| Logout and revoke  | **VERIFIED.** Logout revokes only that session (`revokeSession(userId, sessionId)`); `isSessionLive` exists; password change revokes all sessions.                                                                                                                                                                                                                                                                     |
| Login              | **VERIFIED.** Constant-cost password check, same error for unknown user and wrong password, inactive accounts refused, route rate-limited (`AUTH_RATE_LIMITER`). Login issues tokens without any business context.                                                                                                                                                                                                     |
| Per-request checks | **VERIFIED.** `authenticate` re-reads the user and refuses a non-active user; `resolveTenantContext` requires `X-Business-Id`, validates the selector, checks membership first and business status second, requires a branch for branch-scoped roles, and checks the branch belongs to the business. Nothing is cached, so role removal, staff removal and business suspension apply on the next request to any token. |
| Permissions        | **VERIFIED.** `requirePermission` per route; D-C1 gives counter staff `loyalty:serve`.                                                                                                                                                                                                                                                                                                                                 |

## 4. Business, branch and role boundaries

**VERIFIED:** counter routes are `POST /loyalty/actions/resolve-customer`, `POST /loyalty/actions/lookup-customer`, `POST /loyalty/actions/lookup-purchase`, `POST /loyalty/accounts/:id/purchase`, `GET /loyalty/redemptions/:code`, `POST /loyalty/redemptions/:code/confirm`, plus `GET /businesses/me` and `GET /auth/me`. The existing Serve customers page also calls `GET /businesses` (the business switcher), which a cashier token must not need: the cashier login response will carry the user's eligible businesses and branches instead. **PROPOSED:** binding `businessId` and `branchId` into the token and requiring the request headers to match closes the one gap that exists today (a staff token can be pointed at any business the user belongs to by changing the header).

## 5. Dedicated Worker feasibility from the existing build

- **Build (VERIFIED):** one OpenNext build output (`.open-next`) deployed by `wrangler deploy --name=echo-grid-feedback-web --env=""`. The production web Worker has **no bindings**; its variables are `API_BASE_URL`, `APP_URL`, `NODE_ENV`, `NEXT_PRIVATE_MINIMAL_MODE`, and static assets. A second Worker can run the **same artifact** with different variables, so no second build is needed.
- **Mode switch (PROPOSED):** decide the app mode **at runtime from the request host** (a `CASHIER_HOST` variable compared to the `Host` header) rather than at build time, so the single artifact serves both. The existing Web middleware already handles redirects and the access-token refresh using cookie names; a host-aware branch handles the cashier cookies and routes. On the cashier host every path outside the cashier routes, `/_next`, `/sw.js`, `/offline.html`, icons and the manifest returns 404; on the main host the cashier routes return 404.
- **Configuration (PROPOSED):** two new named environments in `apps/web/wrangler.toml` (production cashier and staging cashier) with a custom domain route for production and `workers_dev` for staging; no bindings (keeps the web-only tool's rule satisfied).
- **No such Worker exists today (VERIFIED by a read-only list):** the account has four Workers (web and API, production and staging).

## 6. Origin, CORS, CSRF and trusted-origin findings

- **CORS (VERIFIED):** the API allow-list (`ALLOWED_ORIGINS`) applies to browser calls. A search of Web client components found no direct browser call to the API: all API calls are server-side (`apiFetch` in actions and server components, and Next route handlers such as `/api/messaging/unread`). So the cashier origin needs **no API CORS change**. Residual check for C4: re-run the search for `fetch(` against absolute API URLs when the cashier pages are written.
- **CSRF (VERIFIED/PROPOSED):** the API authenticates with bearer headers, not cookies, so it has no cookie CSRF surface. On the Web side, server actions rely on Next's same-origin check (no `allowedOrigins` override), and the CSP has `form-action 'self'` and `frame-ancestors 'none'`. Both hold on a dedicated host without change. Cashier cookies use `SameSite=strict` (no cross-site navigation is needed) on top of httpOnly and Secure.
- **Trusted origins:** email links (`WEB_BASE_URL`) and invitations stay on the main origin; the cashier origin sends none. The cashier host is a fixed variable, never taken from request input, which prevents host-header confusion.
- **Staging:** staging uses `workers.dev` hostnames, so the cashier staging Worker has its own `workers.dev` origin (a second Worker), which is a distinct origin by definition.

## 7. Release and governance constraints (locked contracts)

| Contract                                      | Finding                                                                                                                                                                                                               | Consequence                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment governance test                    | **VERIFIED.** Only `deploy-production.yml`, `deploy-staging.yml` and `deploy-web-only.yml` may contain a deploy command; CI and every other workflow must not.                                                        | A cashier deploy must be a job inside those governed workflows (same exact-commit binding, CI gate and `production` environment approval). A brand-new deploy workflow would require an owner-approved edit of that locked test. **Owner decision.** |
| Web-only release tool                         | **VERIFIED.** Pins the worker name `echo-grid-feedback-web`, rejects any resource binding stanza, and reads the Cloudflare account to confirm the production domain `echo-grid.uk` is a custom domain of that Worker. | Compatible: the cashier Worker has no bindings. The tool must gain a parallel check for the cashier Worker and domain, with an exact-name pin.                                                                                                       |
| WEB-1102                                      | **VERIFIED.** Block 0 is not certified; no new Web feature goes to production until certified.                                                                                                                        | C4 and later can be built and tested on staging only. No cashier Worker or domain reaches production before Block 0 is certified **and** the owner authorizes it.                                                                                    |
| Impersonation (#411 and the option b setting) | **VERIFIED.** Impersonation tokens are accepted only when the flag is on.                                                                                                                                             | Cashier tokens are refused when a request carries `impersonatedBy`, and impersonation never targets the cashier origin.                                                                                                                              |
| Financial activation                          | NO-GO                                                                                                                                                                                                                 | Unaffected: the cashier app only reuses existing counter routes.                                                                                                                                                                                     |

## 8. Cloudflare prerequisites (read-only findings; nothing changed)

- **Custom domain (VERIFIED from Cloudflare documentation):** it needs an **active zone on the same account** and a Worker to attach; Cloudflare creates the DNS record and an advanced certificate automatically; a custom domain **cannot be created on a hostname that already has a CNAME record**; changing it needs `Editor` on the Worker plus `Workers Routes Write` on the zone.
- **Zone (VERIFIED indirectly):** the release tool already expects `echo-grid.uk` to be a custom domain of the production Worker, so the zone is on the account.
- **UNKNOWN (cannot be checked from this environment; the sandbox cannot reach the domain or its DNS):** (a) whether `cashier.echo-grid.uk` already has any DNS record, in particular a CNAME that would block the custom domain; (b) whether the CI Cloudflare token has `Workers Routes Write` on the zone, otherwise the owner attaches the domain once in the dashboard.
- **Needed later (not done):** create the production cashier Worker through the governed deploy, attach `cashier.echo-grid.uk` as a custom domain, optional Cloudflare Access is not required.

## 9. Independent sessions on one device

Admin on `echo-grid.uk` and cashier on `cashier.echo-grid.uk` hold separate cookie jars (host-only cookies), separate service-worker registrations and separate storage by origin, so both can stay signed in at once in the same browser profile. Their API sessions are separate rows with separate session ids. Two interactions to design for: (1) the **reuse-detection rule** revokes all sessions of a user on a replay, so a replayed cashier refresh token would also sign the same person out of the admin app (**owner decision:** keep, or revoke only the cashier session family, recommended); (2) password change signs the user out everywhere (acceptable and desirable).
**UNKNOWN until tested:** whether an installed PWA on each platform keeps cookie storage separate from the browser tab for the same origin (not relevant to correctness here because the origins differ, but it affects the sign-in experience); test matrix in section 11.

## 10. Security risks and mitigations

| Risk                                        | Mitigation                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cashier token used on administrative routes | Fail-closed API allow-list in `authenticate`, a route-introspection test that every registered route is refused for a cashier token unless explicitly allowed |
| Header swap to another business             | Token carries `businessId` and `branchId`; mismatching headers are refused                                                                                    |
| Look-alike hostname                         | Fixed variable host; show the hostname on the install panel                                                                                                   |
| Replay of a stolen cashier refresh token    | Rotation with reuse detection; owner decision on scope of revocation (section 9)                                                                              |
| Brute force                                 | Cashier login shares the staff rate limiter                                                                                                                   |
| Host-header confusion                       | Runtime comparison against a configured value only                                                                                                            |
| Misdeploy of the wrong mode                 | Cashier Worker config has no bindings and its own name; web-only tool pin; acceptance test that the wrong host answers 404                                    |

## 11. Remaining owner decisions

1. Governance route: deploy the cashier Worker from jobs inside the existing governed workflows (recommended), or approve a new governed workflow and the edit of the locked governance test.
2. Reuse-detection scope for cashier sessions (revoke only the cashier family, recommended, or all sessions as for the web).
3. Cashier refresh lifetime and idle timeout (proposal 12 hours and 2 hours).
4. Simultaneous cashier sessions per user.
5. Branch recent-activity screen scope and customer-name masking.
6. Staging cashier Worker name (proposal `echo-grid-feedback-cashier-staging`) and production Worker name (proposal `echo-grid-feedback-cashier`).
7. Who attaches `cashier.echo-grid.uk` (owner in the dashboard, or the deploy token if it has zone permission) and confirmation that the hostname is free of any existing DNS record.

## 12. Exact C2 implementation scope (PROPOSED; needs explicit authorization)

**Goal:** add the cashier token concept and the fail-closed route allow-list to the API, with no way to obtain such a token yet. No migration, no UI, no Web change, no Worker.

1. `apps/api/src/auth/jwt.ts`: optional claims `client` (`"cashier"`), `bid` and `brid` on the access token; `signAccessToken` gains an optional options object (backward compatible: existing calls and tokens are unchanged); `verifyAccessToken` validates the new claims (type and shape) and rejects a cashier claim without `bid`.
2. `apps/api/src/middleware/authenticate.ts`: after verification, a cashier token is accepted only if the method and path match the allow-list; it surfaces `client`, business and branch to the context; refused when `impersonatedBy` is present.
3. `apps/api/src/middleware/tenant-context.ts`: when the token has a binding, `X-Business-Id` and `X-Branch-Id` must equal it (a missing branch header is filled from the claim).
4. A new allow-list module (routes: the six counter routes, `GET /businesses/me`, `GET /auth/me`, refresh and logout paths reserved for C3) with a single default-deny matcher.
5. Tests: allow-list accepts exactly those routes and refuses a cashier token on every other registered route (introspect the Hono route table, so a future new route is refused by default); header mismatch refused; impersonation combined with a cashier claim refused; existing web tokens unaffected; token claim forgery and malformed claims refused; a cashier token still passes the normal permission and tenant checks on allowed routes.
6. Files NOT touched: migrations, Gate 2 pins, Web, wrangler, workflows, any secret.
   **Acceptance:** API typecheck, the full API test suite and hosted CI pass; the route-introspection test enumerates all routes; no behavior change for existing tokens.

## 13. C3 dependencies (PROPOSED; later block)

Migration for `refresh_tokens` (`client` with default `web`, nullable `business_id` and `branch_id`) as migration `0071` (re-verify the number at execution) with the **Gate 2 re-pin to 72 migrations**, as in 0067 to 0070 (about 36 pinned lines across scripts and workflows plus the preflight test); `POST /auth/cashier/login`, refresh and logout that preserve the client and binding across rotation; owner session list and revoke can follow in C6. Staging first; each step needs its own authorization.

## 14. Security acceptance criteria for the whole feature

Cashier token refused on every non-allow-listed route (introspection test); binding enforced; role removal, staff removal and business suspension stop cashier access on the next request (tests with the real middleware); cashier cookies never sent to the main host and the reverse (host guard test); no authenticated response cached by the service worker; independent logout in each direction; reuse-detection behavior as decided; audit entries for login, logout, revoke and each counter action; real-device installed-app matrix (Android Chrome, desktop Chrome and Edge, iOS home-screen) recorded; the production Worker and domain only after WEB-1102 certification and explicit authorization.

## 15. Validation results (this block)

Read-only inspection of: `apps/api/src/auth/jwt.ts`, `auth/auth.service.ts` (login, refresh, logout), refresh-token repository, `middleware/authenticate.ts`, `middleware/tenant-context.ts`, loyalty routes, Web `session.ts`, `cookies.ts`, `middleware.ts`, `next.config`, `wrangler.toml`, release workflows and tools, deployment-governance test; a read-only Cloudflare Worker list; Cloudflare documentation on custom domains. Network checks of `echo-grid.uk` from this environment returned no response (UNKNOWN, see section 8). No application tests were run (no code changed).
