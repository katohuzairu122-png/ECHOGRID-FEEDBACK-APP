# CASHIER-PWA-01: independent cashier app on a separate origin (design, version 2)

**Status: DESIGN ONLY. Nothing here is built, migrated, deployed or authorized. The owner approved the architecture on 2026-11-14 (section 0); development blocks C1 and later each need their own explicit authorization. Financial activation remains NO-GO. The WEB-1102 production restriction is unchanged (Block 0 is not certified).**
Baseline: `main` `de997da6` (2026-11-14). Version 2 supersedes version 1 in PR #416 (open, unmerged at the time of writing). Labels: **VERIFIED** (read in source), **PROPOSED**, **NOT IMPLEMENTED**, **BLOCKED**, **UNKNOWN**.

## 0. Owner decision record (2026-11-14, RATIFIED)

The cashier application stays attached to the existing Echo Grid business account. Approved:

1. A dedicated cashier PWA hosted on a **separate origin**.
2. It reuses existing staff identities, credentials, business IDs, memberships and branch assignments.
3. It establishes an **independent cashier authentication session**.
4. No separate cashier accounts, no duplicate businesses, no duplicate loyalty databases.
5. Existing API-enforced permissions and tenant isolation are preserved.
6. Owners and managers may use cashier operations when authorized.
7. Cashier sessions cannot reach administrative endpoints.
8. An "Install Cashier App" entry point is provided in the existing business dashboard.
9. The same authoritative customer, reward, transaction and loyalty records are used.
10. Role revocation, staff removal and business suspension are enforced across both applications. 11. **Hostname `cashier.echo-grid.uk`** and a **dedicated Worker** (decided 2026-11-14).
11. **No device PIN and no mandatory device enrollment** in the initial release (decided 2026-11-14).
    This section records decisions; it authorizes documentation only. Block C1 (read-only preflight) is recorded in `CASHIER_PWA_01_C1_PREFLIGHT.md`; C2 is not started.

## 1. Objective and scope

Let administrators and cashiers work at the same time without sign-in collisions, with the cashier app on its own origin and session, and one shared API, identity provider and database. In scope: separate-origin architecture, authentication and session model, install entry point, permissions, test plan. Out of scope: loyalty program rules (REWARD-CONFIG-01), timezone (TIMEZONE-01), billing, customer authentication.

## 2. Verified existing implementation

- **Staff session cookies are host-only (VERIFIED).** `setSession` writes `ff_access_token` (15 minutes) and `ff_refresh_token` (30 days) as httpOnly, `SameSite=lax`, `Path=/` cookies with **no `Domain` attribute** (`apps/web/src/lib/session.ts`). A different hostname therefore never receives them, so a separate origin isolates the sessions with no extra code. Impersonation stashes the admin session in `ff_admin_*` cookies; the active business is `ff_active_business`.
- **The browser never calls the API directly for session work (VERIFIED in the code path read).** The Web app is a backend-for-frontend: server actions and server components call the API with `apiFetch` using `API_BASE_URL`, adding the bearer token and the `X-Business-Id` and `X-Branch-Id` headers read from cookies. The API CORS allow-list (`ALLOWED_ORIGINS`) therefore applies to browser-side calls only; **UNKNOWN:** whether any browser-side fetch to the API exists (a repository-wide search is part of C1).
- **Deployment shape (VERIFIED):** the Web app is one OpenNext Cloudflare Worker (`echo-grid-feedback-web`) with `APP_URL = https://echo-grid.uk` and `API_BASE_URL` pointing at the API Worker's `workers.dev` address (a custom API domain is planned in comments, not configured). Staging uses `workers.dev` addresses only (no custom domain). Custom domains are not declared in `apps/web/wrangler.toml` (**UNKNOWN:** how the production domain is attached; it is presumably a dashboard setting).
- **Content security policy (VERIFIED):** `frame-ancestors 'none'`, `form-action 'self'`, `default-src 'self'`; server actions use Next's default same-host origin check (no `allowedOrigins` override). A second hostname serving its own pages satisfies both without change.
- **Cashier permissions (VERIFIED):** D-C1 `loyalty:serve` for counter actions, enforced on the API (`requirePermission('loyalty:serve')`); the Web app routes cashiers to `/dashboard/loyalty/scan`.
- **Per-request enforcement (VERIFIED):** `authenticate` loads the user and refuses a non-active user on every request; `resolveTenantContext` then checks the business membership first and the business status second, on every request, with no caching. So role revocation, staff removal and business suspension already take effect on the very next request for any token, wherever it was issued.
- **Refresh tokens (VERIFIED):** `refresh_tokens` has `tokenHash`, `sessionId`, `issuedAt`, `expiresAt`, `revokedAt`, `replacedByTokenId` (rotation), `userAgent`, `ipAddress`. There is no client type or business binding.
- **PWA (VERIFIED):** one manifest (`start_url '/'`, `scope '/'`), one service worker (network-first navigation, cached offline page only, no authenticated caching).
- **Not present (NOT IMPLEMENTED):** the cashier origin, cashier manifest, install entry point, cashier login, scope-limited token, device or session list, remote revoke.

## 3. Proposed target design

### 3.1 Origin architecture (PROPOSED)

Two ways to host a separate origin were compared.

| Option                                      | What it is                                                                                                                                                                                                               | Verdict                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| (i) Dedicated cashier Worker                | A second Worker built from the **same repository and build**, with its own hostname, started in cashier mode (configuration `CASHIER_APP=true`). It serves only `/cashier/*`, the shared static assets and the manifest. | **Recommended**                                                                                                                                   |
| (ii) Second hostname on the existing Worker | Attach another custom domain to `echo-grid-feedback-web` and branch on the request host                                                                                                                                  | Fewer resources, but staging has only one `workers.dev` hostname so isolation could not be tested there, and one deployment would carry both apps |

- Cashier mode (i): a request-host guard in the Web middleware makes the cashier Worker answer only cashier routes (anything else is 404), and makes the main Worker redirect or 404 `/cashier/*`. No cashier cookie or route exists on the main origin and vice versa.
- Shared: the same API Worker, the same identity provider (`/auth/*`), the same Hyperdrive and database. The cashier Worker holds no database access and no secrets beyond what the Web Worker holds today (its configuration is the API address and the application URL).
- **Hostname (decided):** production `cashier.echo-grid.uk` (a subdomain of the registered domain already used); staging: a second `workers.dev` Worker (proposal `echo-grid-feedback-cashier-staging`; no custom domain exists on staging today). Worker names are still proposals. No domain is created or configured by this document; whether the hostname is free of an existing DNS record is **UNKNOWN** (see the C1 preflight).

### 3.2 Authentication architecture (PROPOSED)

- **Independent sign-in (recommended over handoff).** The cashier signs in on the cashier origin with their **own existing staff email and password**; no credentials or tokens are handed across origins. Reasons: accountability (each action is attributable to the person), no transfer of administrator privilege, and cookies cannot be shared across origins anyway. A secure handoff would need a one-time code exchanged between origins; it is described as an alternative in section 11 only for device enrollment, not for signing in.
- **New API endpoint** `POST /auth/cashier/login` (the API stays single and shared): checks the existing credentials with the existing rate limiter and lockout rules, requires the user to hold `loyalty:serve` (or a management permission) in the chosen business, and issues a **scope-limited token pair**. Claims: `client: "cashier"`, `businessId`, `branchId` (null for business-wide staff). The refresh row records `client = cashier` plus the same business and branch.
- **Scope allow-list on the API (the real privilege boundary).** Origin isolation protects browser cookies, but both apps call the same API, so the API must also refuse a cashier token on every administrative route. A `client: "cashier"` token is accepted only on the counter routes (`loyalty:serve` routes, `GET /businesses/me`, `GET /auth/me`, refresh, logout, the branch recent-activity read). Anything else returns the normal opaque denial, whatever permissions the user holds.
- **Tenant binding:** `X-Business-Id` and `X-Branch-Id` must equal the token claims; the cashier cannot switch business without signing in again.
- **Owners and managers:** they may sign in at the cashier origin with their own credentials; their cashier token is still scope-limited (decision 7), so using the cashier app never exposes administrative endpoints.
- **Cookies on the cashier origin:** `ff_cashier_access` and `ff_cashier_refresh` (httpOnly, `Secure`, `SameSite=strict` is considered because no cross-site navigation is needed; host-only). Distinct names are kept even on a separate origin because `localhost` development shares cookies across ports and the names prevent accidental reuse.

### 3.3 Session behavior (PROPOSED)

- **Refresh:** rotation as today (the old refresh token is replaced and reuse is detected); cashier refresh has its own shorter lifetime (section 11).
- **Logout:** revokes only the cashier token family (`sessionId`); the admin session on the main origin is untouched, and the reverse.
- **Revocation and role changes:** per-request checks (verified above) apply unchanged: demoting a cashier, removing staff, or suspending the business ends access on the next request across both apps. Additionally (new): an owner view of active cashier sessions (device user agent, branch, last used) with remote revoke, and "revoke all of this user's sessions" on staff removal.
- **Impersonation:** cashier sessions are refused while a request carries an impersonation token, and impersonation can never open the cashier origin.

### 3.4 Business and branch context (PROPOSED)

After credential check the API returns the user's businesses and branch grants (existing membership data). One business and one branch: selected automatically. Several: the cashier picks on the sign-in flow; the API validates the choice against the same membership and branch-grant rules `resolveTenantContext` uses, then binds it into the token. A user with a role grant on the business but no branch grant for the chosen branch is refused (existing rule: "branch context is required for this role").

### 3.5 Reuse without duplicating business logic (PROPOSED)

The cashier origin reuses the existing counter routes and services unchanged (resolve customer, lookup, purchase, redemption confirm); only the token that reaches them differs. The Serve customers components move into a shared module imported by both the main dashboard and the cashier routes, so there is one implementation of the screens as well. Customer, reward, ledger and loyalty records stay in the existing database (decisions 4 and 9). No new tables hold business data; the only new storage is the refresh-token client and binding columns and cashier audit actions.

### 3.6 Installation and routing (PROPOSED)

- Cashier origin routes: `/` (landing and install), `/login`, `/select`, `/serve`, `/activity`, `/account` (the `/cashier` prefix is internal to the codebase; the cashier hostname serves them from its root).
- Manifest on the cashier origin: `id` and `scope` at the origin root, `start_url "/"`, name "Echo Grid Cashier", own icons; a service worker for the cashier origin keeps today's rule (network-first, offline page only, no authenticated caching).
- **Install entry point (decision 8):** on the existing dashboard Serve customers page and in the owner settings, an "Install Cashier App" panel that explains the app, shows the cashier address with a copy button and QR code, and links to it; the browser's own install prompt appears on the cashier origin. iOS shows "Add to Home Screen" steps. The dashboard does not install anything itself (a PWA installs only from its own origin).

### 3.7 Permission matrix (enforced by the API)

| Capability                                                          | Cashier app (cashier token)        | Admin or manager dashboard |
| ------------------------------------------------------------------- | ---------------------------------- | -------------------------- |
| Resolve customer QR, lookup customer, lookup purchase               | Yes (`loyalty:serve`)              | Yes                        |
| Record purchase, confirm redemption                                 | Yes                                | Yes                        |
| Recent activity of the bound branch (read only)                     | Yes                                | Yes (all branches)         |
| Settings, team, roles, billing, rewards, tiers, programs, analytics | **No** (refused by the allow-list) | Per D-C1                   |
| Loyalty adjustments, customer directory                             | **No**                             | Per D-C1                   |
| Switch business or branch                                           | **No** (sign in again)             | Yes                        |

## 4. Data ownership and contracts

No separate accounts or data stores (decisions 2 and 4): the same `users`, role grants, branches and loyalty tables. New (PROPOSED, needs a migration and the Gate 2 re-pin): `refresh_tokens.client`, `business_id` and `branch_id` for cashier rows; audit actions `auth.cashier_login`, `auth.cashier_logout`, `auth.cashier_session_revoked`; a read endpoint for branch recent activity (requested separately as a bug report and VERIFIED missing today).

## 5. Authentication and authorization

Sections 3.2 to 3.4 and 3.7. Additional rules: the cashier login shares the staff rate limiter and password rules; password reset and invitation emails stay on the main origin (they use `WEB_BASE_URL`, unchanged); the cashier origin offers a "forgot password" link that goes to the main origin.

## 6. UI and user journeys

Admin: unchanged, plus the install panel. Manager: opens the install panel, copies the cashier link or shows its QR code to the device. Cashier: opens the cashier address, installs, signs in with their own email and password, picks the branch if needed, serves customers, signs out or times out back to the cashier sign-in. Owner: sees active cashier sessions and can revoke them.

## 7. Security and failure handling (threat analysis)

| Threat                                                                                                                                                                           | Control                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Session collision between admin and cashier                                                                                                                                      | Separate origins (host-only cookies) plus distinct cookie names and separate token families                  |
| Stolen cashier token used against administrative APIs                                                                                                                            | Scope claim and API allow-list (the origin does not protect the shared API)                                  |
| Admin token placed in the cashier app, or the reverse                                                                                                                            | Each origin accepts only its own token type; the API refuses a mismatch                                      |
| Cross-tenant use                                                                                                                                                                 | Header and claim must match; membership and business status re-read per request                              |
| Role removed, staff removed, business suspended                                                                                                                                  | Per-request checks apply to both apps; remote revoke for sessions                                            |
| Open redirect or origin confusion between the two hostnames                                                                                                                      | Fixed, configured hostnames only; no redirect targets taken from request input; guard rejects the wrong host |
| Phishing look-alike of the cashier hostname                                                                                                                                      | Hostname shown in the install panel; consider a name shown on screen after sign-in                           |
| Shared or lost device                                                                                                                                                            | Short refresh lifetime, remote revoke, logout revokes the family, optional device enrollment                 |
| XSS, CSRF                                                                                                                                                                        | httpOnly cookies, `SameSite`, Next's server-action origin check, existing CSP                                |
| Offline replay or stale data                                                                                                                                                     | No authenticated caching in the service worker                                                               |
| Audit gaps                                                                                                                                                                       | Login, logout, revoke and each counter action audited with branch and user agent                             |
| Failure handling: an expired or revoked session returns to the cashier sign-in with no data left on screen; a refused scope shows a clear "not allowed in the cashier app" page. |

## 8. Backward compatibility

The main origin and every existing admin or cashier flow are unchanged; the cashier app is opt-in. The old counter redirect remains until the owner retires it. Additive migration only. No customer-facing change.

## 9. Dependencies

- Hosting: a second Worker (or domain), its deployment workflow and a custom-domain record are needed for production; they are infrastructure steps that need separate owner authorization and are not created here.
- API changes and a migration come first (C2, C3); both need the Gate 2 re-pin and authorization (staging first).
- The recent-activity endpoint also serves the owner's bug report. Business-local time display follows TIMEZONE-01; purchase screens read the active program from REWARD-CONFIG-01 once it exists. No Web feature goes to production before WEB-1102 is certified.

## 10. Acceptance criteria

A cashier token is refused on every administrative route group (a test per group); a mismatched business or branch header is refused; signing in on the cashier origin never changes the admin session in the same browser, and the reverse; logout and remote revoke end only the targeted family; demotion, staff removal and business suspension stop cashier access on the next request; owners and managers sign in with their own credentials and still get a scope-limited token; the main origin cannot serve cashier routes and the cashier origin cannot serve any other route; the manifest installs on Android Chrome, desktop Chrome and Edge, and the iOS home-screen flow is documented from a real device test; no authenticated response is cached; every login, logout, revoke and counter action is audited.

## 11. Open owner decisions and remaining conflicts

1. **Hostname:** approve `cashier.echo-grid.uk` or choose another; and the staging approach (second `workers.dev` Worker).
2. **Hosting shape:** dedicated cashier Worker (recommended) versus a second hostname on the existing Worker.
3. Cashier refresh lifetime and idle timeout (proposal: 12 hours absolute, 2 hours idle).
4. Whether a shift PIN or a device-enrollment code (the only handoff considered) is wanted.
5. Maximum simultaneous cashier sessions per user.
6. What the branch recent-activity screen shows, who sees which branch, and whether customer names are masked.
7. Whether the cashier address and a name check should be shown at sign-in to resist look-alike domains.
8. **Conflicts to resolve:** the API still has no scope concept, so origin isolation alone is not enough (resolved by 3.2, needs C2); the owner's decision 6 (owners and managers may use cashier operations) is kept compatible with decision 7 by scope-limiting every cashier token; production domain attachment is currently undocumented in the repository.

## 12. Implementation block breakdown (PROPOSED, each needs explicit authorization)

- **C1:** owner decisions above; repository-wide search for any browser-side API call; document how the production domain is attached. No code.
- **C2:** API scope claim, allow-list and tenant binding, with route-by-route tests (no UI, no migration).
- **C3:** cashier login, refresh and logout endpoints and token-family columns (migration, Gate 2 re-pin).
- **C4:** cashier Worker mode, host guard, `/login` `/select` `/serve` pages reusing shared components, manifest.
- **C5:** install panel on the main dashboard and install UX; service worker rules.
- **C6:** owner session list, remote revoke, audit actions.
- **C7:** branch recent-activity API and page.
- **C8:** staging origin setup (second Worker) and real-device test matrix; production hostname only after separate authorization.
