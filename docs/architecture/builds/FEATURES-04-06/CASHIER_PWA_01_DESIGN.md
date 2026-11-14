# CASHIER-PWA-01: independent cashier app and session (design only)

**Status: DESIGN ONLY. Nothing here is built, migrated, deployed or authorized. Owner review is required before any development block. Financial activation remains NO-GO. The WEB-1102 production restriction is unchanged (Block 0 is not certified).**
Baseline: `main` `de997da6` (2026-11-14). Open PR at inspection: #415 (dialog scroll fix, unrelated). Labels: **VERIFIED** (read in source), **PROPOSED**, **NOT IMPLEMENTED**, **BLOCKED**, **UNKNOWN**.

## 1. Objective and scope

Let a business administrator and a cashier work at the same time without their sign-ins colliding, by giving the cashier an installable app with its own session. In scope: cashier sign-in, session isolation, install and routing, screens, permission boundaries. Out of scope: loyalty program rules (REWARD-CONFIG-01), timezone (TIMEZONE-01), billing, any change to customer authentication.

## 2. Verified existing implementation

- **One staff session per browser origin (VERIFIED).** The Web app stores the staff session in two httpOnly cookies, `ff_access_token` (15 minutes) and `ff_refresh_token` (30 days), `SameSite=lax`, `Path=/` (`apps/web/src/lib/session.ts`, `cookies.ts`). A second staff sign-in on the same origin replaces them, which is the collision the owner describes. Impersonation stashes the real admin session in `ff_admin_*` cookies and sets `ff_impersonating`; the active business is `ff_active_business`.
- **Cashier definition (VERIFIED).** D-C1 gives counter staff only `loyalty:serve` (plus read access to the business and branches); owner and manager keep management permissions. The Web app classifies a workspace as cashier, management or unavailable (`classifyWorkspace`) and redirects cashiers to `/dashboard/loyalty/scan` (`CASHIER_HOME`). Every `loyalty:serve` route is enforced on the API (`requirePermission('loyalty:serve')`): resolve-customer, lookup-customer, lookup-purchase, record purchase, redemption lookup and confirm.
- **API session model (VERIFIED).** `refresh_tokens` rows carry `tokenHash`, `sessionId`, `issuedAt`, `expiresAt`, `revokedAt`, `replacedByTokenId` (rotation), `userAgent`, `ipAddress`. Staff endpoints: login, refresh, logout, `/auth/me`. There is no per-client or per-business binding on a staff token.
- **PWA (VERIFIED).** One manifest (`apps/web/src/app/manifest.ts`): `start_url '/'`, `scope '/'`, name "Echo Grid", 192 and 512 icons. One service worker (`public/sw.js`, registered globally): network-first for navigations with a cached offline page only; it deliberately caches no authenticated responses.
- **Not present (NOT IMPLEMENTED):** a cashier manifest, "Install" entry point, cashier sign-in page, scope-limited tokens, a cashier session list or remote revoke, device registration.

## 3. Proposed target design

### 3.1 Authentication architecture (PROPOSED)

Same staff identity, new **cashier session** type. No identity linking: the cashier signs in with the existing staff email and password and nothing else is merged.

- New endpoint `POST /auth/cashier/login`: validates the staff credentials, requires the user to hold `loyalty:serve` in the chosen business, and issues a **scope-limited** token pair. The access token carries claims `client: "cashier"`, `businessId`, and `branchId` (or null for business-wide staff). The refresh token row records `client = cashier` and the same `businessId` and `branchId`.
- **API allow-list:** a token with `client: "cashier"` is accepted only on the counter routes (the `loyalty:serve` routes, `GET /businesses/me`, `GET /auth/me`, refresh and logout). On every other route the middleware refuses it, whatever permissions the user holds. Even a stolen cashier token therefore cannot reach settings, team, billing, rewards configuration or analytics.
- **Tenant binding:** the `X-Business-Id` and `X-Branch-Id` headers must equal the token claims or the request is refused. The cashier cannot switch business inside the app.
- Permissions are still re-read from the database on each request (existing behavior), so a demoted cashier loses access on the next call.

### 3.2 Session isolation strategy (PROPOSED)

The manifest does not isolate cookies. Two options were evaluated.

| Option                                               | Isolation                                                                     | Cost                                                                                | Verdict                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------- |
| A. Same origin, distinct cookie names                | Admin and cashier cookies never overwrite each other; separate token families | None: no new domain                                                                 | **Recommended**                          |
| B. Separate origin (for example a cashier subdomain) | Strongest: the browser keeps cookie jars apart                                | New hostname, Worker route, allowed-origin and CORS changes, another deploy surface | Not now; revisit if A fails device tests |

- Option A: cashier cookies `ff_cashier_access` and `ff_cashier_refresh`, used only by `/cashier/*` routes and server actions. `/dashboard` and `/platform` never read them, and `/cashier` never reads `ff_access_token`. Cookie path scoping is **not** treated as a security boundary; the security boundary is the scope-limited token and the API allow-list in 3.1.
- Because sessions are independent token families (`sessionId`), signing out of the cashier app revokes only that family; the admin session is untouched, and the reverse.
- **UNKNOWN (must be tested, not assumed):** whether an installed PWA shares cookie storage with the browser on each platform (Android Chrome, iOS Safari home-screen apps, desktop Chrome and Edge). Option A is chosen so the design does not depend on the answer.

### 3.3 Installation and routing (PROPOSED)

- Routes: `/cashier` (landing and install), `/cashier/login`, `/cashier/select` (business and branch, only if the user has several), `/cashier/serve` (the existing Serve customers flow, reused), `/cashier/activity` (recent activity of this device's branch), `/cashier/account`.
- Second manifest at `/cashier/manifest.webmanifest`: `id "/cashier"`, `start_url "/cashier"`, `scope "/cashier/"`, name "Echo Grid Cashier", `display standalone`, its own icon set. The `/cashier` pages link only this manifest.
- "Install Cashier App" button on `/cashier` (Chrome and Edge use the install prompt; iOS shows "Add to Home Screen" instructions). A link to it is added to the existing Serve customers page for managers.
- The service worker keeps today's rule (network-first, offline shell only, no caching of authenticated data); a separate offline page for the cashier scope.

### 3.4 Permission matrix (PROPOSED, enforced by the API)

| Capability                                            | Cashier app               | Admin or manager dashboard |
| ----------------------------------------------------- | ------------------------- | -------------------------- |
| Resolve customer QR, lookup customer, lookup purchase | Yes (`loyalty:serve`)     | Yes                        |
| Record a purchase, confirm a redemption               | Yes                       | Yes                        |
| Recent activity of own branch                         | Yes (read only)           | Yes (all branches)         |
| Business settings, team, roles, billing               | **No**                    | Yes                        |
| Rewards, tiers and program configuration              | **No**                    | Yes (owner, manager)       |
| Loyalty adjustments, customer directory               | **No**                    | Per D-C1                   |
| Switch business                                       | **No** (bound at sign-in) | Yes                        |

### 3.5 Cashier screen inventory (PROPOSED)

Sign-in; business and branch picker; Serve (scan or type a customer lookup); customer card with purchase entry; redemption code confirm; recent activity (see the open item below); account and sign out; offline notice.

## 4. Data ownership and contracts

Staff users and roles are unchanged. New data (PROPOSED, needs a migration and Gate 2 re-pin): `refresh_tokens.client` (`web` default, `cashier`), `business_id` and `branch_id` columns on cashier rows, and an audit action set (`auth.cashier_login`, `auth.cashier_logout`, `auth.cashier_session_revoked`). The "recent activity" endpoint is a new read API (also requested as a bug report): it lists purchases and redemptions for the token's branch with time, cashier and amount; it does not exist today (VERIFIED: only per-customer history exists).

## 5. Authentication and authorization

Covered in 3.1 and 3.4. Additional rules: cashier login uses the existing rate limiter; password reset and MFA rules for staff are unchanged; cashier sessions are refused while impersonating; platform roles cannot open the cashier app through impersonation.

## 6. UI and user journeys

Admin: unchanged. Manager: opens Serve customers, taps "Set up a cashier device", sees the install link. Cashier: opens `/cashier`, installs, signs in once (refresh lifetime shorter than the admin's, see open decisions), picks the branch if needed, serves customers; signing out or an idle timeout returns to the cashier sign-in only.

## 7. Security and failure handling (threat analysis)

| Threat                                                                                                                                                                                       | Control                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Cookie collision between admin and cashier                                                                                                                                                   | Distinct cookie names and token families (3.2)                                                   |
| Stolen cashier token used on admin APIs                                                                                                                                                      | Scope claim with API route allow-list (3.1)                                                      |
| Session substitution (admin token in the cashier app)                                                                                                                                        | `/cashier` accepts only `client: "cashier"` tokens; the reverse is refused                       |
| Cross-tenant use                                                                                                                                                                             | Header and claim must match; permissions re-read per request                                     |
| Privilege escalation by role change                                                                                                                                                          | Per-request permission read; cashier tokens cannot gain scope                                    |
| Shared or lost device                                                                                                                                                                        | Short refresh lifetime, owner-visible session list with remote revoke, logout revokes the family |
| XSS or CSRF                                                                                                                                                                                  | httpOnly cookies, `SameSite`, server-action origin checks (existing)                             |
| Offline replay or stale data                                                                                                                                                                 | No authenticated caching in the service worker                                                   |
| Audit gaps                                                                                                                                                                                   | Login, logout, revoke and each counter action are audited with branch and device user agent      |
| Failure handling: an expired or revoked session returns to `/cashier/login` with no data left on screen; a refused scope returns a clear "not allowed in the cashier app" page, not a crash. |

## 8. Backward compatibility

Existing admin and cashier users keep working unchanged through `/dashboard`; the cashier app is opt-in. The old counter redirect (`CASHIER_HOME`) stays until the owner retires it. No customer-facing change. One migration (refresh token client and binding), purely additive.

## 9. Dependencies

- Independent of TIMEZONE-01 and REWARD-CONFIG-01, except that "recent activity" should show business-local times (TIMEZONE-01 display rule, which already works in the Web app) and that purchase verification must resolve the active program once REWARD-CONFIG-01 exists.
- Any migration needs the Gate 2 re-pin and owner authorization (staging first). No Web feature goes to production before WEB-1102 is certified.

## 10. Acceptance criteria

A cashier token is refused on every non-counter route (test each route group); a cashier token with a mismatched business header is refused; signing in to the cashier app does not log out an admin in the same browser, and the reverse; logout and remote revoke end only the targeted family; a demoted user loses counter access on the next request; the manifests install on Android Chrome, desktop Chrome and Edge, and the iOS home-screen flow is documented from a real test; no authenticated response is cached; all actions appear in the audit log.

## 11. Open owner decisions

1. Option A (same origin) or B (separate origin).
2. Refresh lifetime and idle timeout for cashier sessions (proposal: 12 hours absolute, 2 hours idle).
3. Whether owners and managers may also sign in to the cashier app.
4. Whether a shift PIN or device registration is wanted.
5. What "recent activity" shows, who sees which branch, and whether customer names are masked.
6. Maximum simultaneous cashier sessions per user.

## 12. Implementation block breakdown (PROPOSED, each needs authorization)

- C1: owner review and decisions.
- C2: API scope claim, allow-list and tenant binding, with tests (no UI).
- C3: cashier login, refresh and logout endpoints, token-family columns (migration).
- C4: `/cashier` pages and second manifest; reuse of Serve customers.
- C5: install UX and service worker rules.
- C6: owner session list and remote revoke; audit actions.
- C7: "recent activity" read API and page.
- C8: real-device test matrix and acceptance run.
