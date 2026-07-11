# Architecture

## Purpose & Scope

This document is the authoritative architecture reference for Echo Grid Feedback's
shared platform: the Multi-Tenant Foundation (Blocks 1-10) plus the frontend
foundation introduced while building the first feature module, Branch
Management (Blocks 1-7) — together, what every feature module (QR
Engagement, Digital Loyalty, AI Sentiment Analytics) builds on. QR
Engagement (feature module 2), Digital Loyalty (feature module 3), and AI
Sentiment Analytics (feature module 4) are all built *on top of* that shared
platform rather than extending it, and are documented inline throughout this
file (Component Responsibilities, Security, Dependencies, Risks,
Multi-Tenancy Model) rather than in their own documents — see the note below
on when a module earns one. It covers system design, request lifecycle,
multi-tenancy model (now including the customer identity system Digital
Loyalty introduced), both apps' layered architecture, security architecture,
and scaling posture as implemented today.

None of the four feature modules shipped so far have needed a dedicated
architecture document. Even AI Sentiment Analytics' async classification
pipeline and Digital Loyalty's points-engine transaction design and
dual-identity model — the two most complex module-specific pieces built to
date — are fully explained inline here (Layered Architecture's
dependency-direction note, Multi-Tenancy Model, Component Responsibilities)
without needing one. The patterns each module established while building
`apps/web`'s screens (the BFF auth pattern, now extended to a second,
parallel customer identity domain; Server Component/Server Action layering;
the design system) are genuinely platform-wide, reused by every future
module's UI, so they belong here rather than in a module-specific document.
Revisit this "no dedicated doc" convention if a future module's pipeline
grows complex enough that inline coverage stops being legible.

Companion references: [ERD.md](./ERD.md) (database), [API.md](./API.md) (HTTP
contract), [SETUP.md](./SETUP.md) (running it).

## System Overview

```
                        ┌───────────────────────────┐
                        │   Client (browser / QR)     │
                        └──────────────┬──────────────┘
                                       │ HTTPS
                        ┌──────────────▼──────────────┐
                        │   Cloudflare Edge Network     │
                        │   (TLS termination, DDoS,     │
                        │    edge cache, 300+ PoPs)      │
                        └───┬───────────────────────┬──┘
                 static/SSR │                       │ /api/v1/*, /health
                 ┌──────────▼─────────┐   ┌─────────▼──────────┐
                 │  apps/web Worker     │   │  apps/api Worker    │
                 │  Next.js (OpenNext)  │   │  Hono                │
                 │  Server Actions/     │   │                      │
                 │  Components only --  │   │                      │
                 │  browser JS never    │   │                      │
                 │  calls apps/api      │   │                      │
                 └──────────┬───────────┘   └─────────┬───────────┘
                             │ fetch(API_BASE_URL), server-to-server,│
                             │ Bearer <accessToken> from httpOnly    │
                             │ cookie -- see BFF pattern below       │
                             └──────────────────────────────────────►
                                                                     │
        ┌───────────────┬──────────────────┬────────────────┬──────▼──────┐
        │               │                  │                │             │
  ┌─────▼─────┐  ┌──────▼──────┐   ┌───────▼──────┐  ┌──────▼─────┐ ┌─────▼──────┐
  │ Hyperdrive │  │ R2          │   │ KV            │  │  Queues     │ │ Rate       │
  │ (conn.     │  │ (UPLOADS)   │   │ (CACHE)       │  │  (JOBS)     │ │ Limiting   │
  │  pooling)  │  │             │   │               │  │             │ │ (3 bindings)│
  └─────┬──────┘  └─────────────┘   └───────────────┘  └─────────────┘ └────────────┘
        │
  ┌─────▼──────┐
  │  Neon       │
  │  Postgres   │
  └─────────────┘
```

Both apps deploy as independent Cloudflare Workers. `apps/web` never talks to
Postgres directly — it only calls `apps/api` over HTTPS, same as any external
client would. This keeps the database and its credentials reachable from exactly
one deployable unit. As of Branch Mgmt Block 3, *only `apps/web`'s own server*
calls `apps/api` — the browser calls same-origin Server Actions on `apps/web`
instead (see "BFF Auth Pattern" below), so `apps/api`'s CORS allow-list is not
on the critical path for the primary web client at all.

## Layered Architecture (apps/api)

```
┌──────────────────────────────────────────────────────────────────┐
│ Hono app                              src/index.ts                 │
│  /health (unversioned, no middleware)   /api/v1 (requestId, cors,   │
│                                           secureHeaders, rateLimit,  │
│                                           auditTrail)                │
├──────────────────────────────────────────────────────────────────┤
│ Routes         src/auth/auth.routes.ts, src/businesses/business.    │
│                routes.ts — HTTP <-> service translation only, no    │
│                business rules live here                             │
├──────────────────────────────────────────────────────────────────┤
│ Middleware     authenticate -> resolveTenantContext ->              │
│                requirePermission(key)   src/middleware/*.ts         │
├──────────────────────────────────────────────────────────────────┤
│ Services       AuthService, BusinessService, AuthorizationService,  │
│                RoleProvisioningService — framework-agnostic,        │
│                constructor-injected, unit-testable without a        │
│                running Worker                                       │
├──────────────────────────────────────────────────────────────────┤
│ Repositories   one class per entity, src/repositories/*.ts —        │
│                constructor-injected Database, every business-owned  │
│                entity method requires businessId                    │
├──────────────────────────────────────────────────────────────────┤
│ Data access    Drizzle ORM   src/db/schema/*, src/db/client.ts      │
│                node-postgres over the Hyperdrive binding            │
└──────────────────────────────────────────────────────────────────┘
```

Dependencies point downward only. Routes never touch Drizzle directly; services
never import Hono. The documented exceptions are `BusinessService` (business
create + role seeding + owner grant must succeed or fail together),
`LoyaltyAccountService`, and `LoyaltyRedemptionService` (Digital Loyalty
Blocks 3-4) — all three own a `db.transaction()` directly rather than taking
injected repositories, because their operations span a balance update, a
tier recalculation, and an append-only ledger insert that must all succeed
or all roll back together. Every other service takes injected repositories,
and is unit-testable with in-memory fakes as a direct consequence; these
three are integration-test-only (`test/integration/loyalty-*`) since a fake
`Database.transaction()` can't meaningfully stand in for a real one.

## Layered Architecture (apps/web)

Introduced in Branch Mgmt Blocks 2-5, first exercised end to end by Branch
Management's own screens. The pattern below is what every future module's UI
reuses — it is not branch-specific.

```
┌──────────────────────────────────────────────────────────────────┐
│ Pages/Layouts   src/app/**/page.tsx, layout.tsx — async Server     │
│                 Components; fetch data server-side via apiFetch(), │
│                 never ship data-fetching JS to the browser         │
├──────────────────────────────────────────────────────────────────┤
│ Client          'use client' components only where interactivity   │
│ Components      requires it (forms, dialogs) — src/app/**/*.tsx,   │
│                 call Server Actions via useActionState or directly │
├──────────────────────────────────────────────────────────────────┤
│ Server Actions  src/lib/actions/*.ts, 'use server' — the ONLY      │
│                 way this app performs a mutation; call apiFetch()  │
│                 (authenticated) or the API directly (auth actions, │
│                 which don't have a token yet), then                │
│                 revalidatePath() so the UI reflects the change     │
├──────────────────────────────────────────────────────────────────┤
│ API client      src/lib/api-client.ts's apiFetch() — the one       │
│                 chokepoint for authenticated calls to apps/api;    │
│                 attaches the access-token cookie, retries once     │
│                 through a refresh on a 401                         │
├──────────────────────────────────────────────────────────────────┤
│ Session         src/lib/session.ts ('server-only') — httpOnly      │
│                 cookie read/write via next/headers; src/lib/       │
│                 cookies.ts holds just the cookie NAME constants,   │
│                 safe to import from middleware.ts (Edge runtime,   │
│                 can't use next/headers)                            │
├──────────────────────────────────────────────────────────────────┤
│ Design system   src/components/ui/ — Button, Input, Label, Card,   │
│                 Dialog (Base UI). cva for variants, Tailwind v4     │
│                 for tokens (src/app/globals.css's @theme)          │
└──────────────────────────────────────────────────────────────────┘
```

**BFF (Backend-for-Frontend) auth pattern** — the most consequential
architectural decision in this layer. The browser never receives an access
or refresh token in any response body; it only ever holds an httpOnly
session cookie it cannot read. Concretely:

1. A login/signup form (`'use client'`) submits to a Server Action
   (`lib/actions/auth.ts`), which calls `apps/api`'s `/auth/login` or
   `/auth/signup` **server-to-server** (no CORS involved — this is not a
   browser request) and writes the returned token pair as httpOnly,
   `sameSite=lax` cookies (`lib/session.ts`).
2. Every subsequent authenticated request originates from a Server
   Component or Server Action calling `apiFetch()`, which reads the
   access-token cookie server-side and attaches it as a Bearer header.
3. `middleware.ts` gates protected routes on refresh-token-cookie
   *presence* only (no network call per request); actual token validity is
   enforced by `apiFetch()`'s 401-triggers-a-refresh-and-retry logic, and
   `dashboard/layout.tsx` re-checks presence server-side as defense-in-depth
   in case the middleware matcher config ever drifts.

Chosen over a direct browser-to-API integration (tokens in `localStorage` or
a client-readable cookie) because it closes off the most common XSS
token-theft vector entirely — there is no token for injected client-side JS
to read, no matter how it got there. The cost is that every authenticated
data need becomes a server round trip (a Server Component fetch or a Server
Action), not a client-side `fetch` — judged worth it for a platform storing
customer feedback and business data, not a public read-mostly content site.

## Request Lifecycle

Example: `GET /api/v1/businesses/audit-log`

```
Client
  │ GET /api/v1/businesses/audit-log
  │ Authorization: Bearer <access-jwt>
  │ X-Business-Id: <uuid>
  ▼
requestId → cors → secureHeaders → rateLimit(API_RATE_LIMITER) → auditTrail (pre)
  ▼
authenticate                 verifies JWT, sets userId        401 UNAUTHENTICATED
  ▼                                                            on missing/invalid
resolveTenantContext         confirms membership, loads        400 MISSING_BUSINESS_
                              effective permission set          CONTEXT / 403 NOT_A_MEMBER
  ▼
requirePermission('audit:view')   checks key in the set        403 PERMISSION_DENIED
  ▼
route handler                 AuditLogRepository.listForBusiness()
  ▼
ok(c, data)                   { success: true, data: [...] }
  ▼
auditTrail (post)             GET is non-mutating → no audit_log row written
  ▼
Client receives 200
```

Any `AppError` thrown at any layer (middleware, service, repository) is caught
by the single `app.onError(errorHandler)` registered in `index.ts` and mapped to
`{ success: false, error: { code, message, details? } }` with its declared
status. Anything thrown that is *not* an `AppError` — a genuine bug — is logged
server-side and returned as a generic `500 INTERNAL_ERROR` with no internal
detail leaked to the client.

## Multi-Tenancy Model

Shared-schema, `business_id`-scoped — one Postgres database serves every tenant,
not one database/schema per tenant. Chosen over database-per-tenant because the
platform's own requirement is "millions of users, businesses, branches" with no
hard-coded limits; provisioning a new Postgres database per signup does not
scale operationally at that volume, and Neon/Hyperdrive connection limits make
thousands of per-tenant databases impractical. The trade-off, accepted
deliberately: tenant isolation is enforced in application code (every
business-owned repository method requires `businessId`), not by the database
engine itself. See [ERD.md](./ERD.md#design-conventions) for the schema-level
conventions this depends on.

Key model decisions:

- **`users` is a global identity**, not tenant-locked. `user_business_roles` —
  not a column on `users` — is the sole source of truth for which businesses a
  person belongs to, with what role, business-wide or scoped to one branch
  (nullable `branch_id`). One person can hold different roles at different
  businesses or branches simultaneously.
- **`roles` always belong to exactly one business.** There is no shared/global
  "system role" concept. Every new business gets four starter roles (Owner,
  Admin, Manager, Staff) seeded on creation, which it can then freely rename,
  delete, or extend.
- **`permissions` is a single global, platform-defined catalog** (22 keys today,
  see [API.md](./API.md#permissions-catalog)), seeded by migrations as features
  ship — never created ad hoc by a tenant. *(This count was found stale at "16"
  while documenting Notifications (module 5) — it should have been updated to
  18 back in AI Sentiment Analytics' own docs pass and wasn't; fixed here.)*
- **`customers` is a second, parallel global identity** (Digital Loyalty
  Block 1), deliberately modeled after the `users`/`user_business_roles`
  split above rather than inventing a new pattern: `customers` is the
  phone-verified identity (one row per phone, platform-wide), and
  `loyalty_accounts` is the business-scoped membership (one row per
  customer-per-business, mirroring `user_business_roles`). The two identity
  systems — staff (`users`, JWT via `JWT_ACCESS_SECRET`, dashboard access,
  RBAC) and customer (`customers`, JWT via `CUSTOMER_JWT_SECRET`, SMS-OTP
  identity, no RBAC concept at all) — never overlap and are not designed to
  ever merge; a customer can never become staff by any existing mechanism,
  and vice versa.
- **`users.platformRole` is a third, orthogonal tier** (Platform Admin
  Console Block 1) — cross-tenant, not business-scoped, so it cannot live in
  `user_business_roles` the way ordinary Owner/Admin/Manager/Staff grants do.
  NULL (not a platform admin) for the overwhelming majority of rows; a
  non-null value (`support | billing | admin`) is layered on top of, never a
  replacement for, a user's ordinary business-scoped roles — one person can
  hold both simultaneously. Checked by a dedicated `requirePlatformRole`
  middleware, entirely independent of `resolveTenantContext`/
  `requirePermission`, since platform routes carry no `X-Business-Id` and
  have no tenant membership to resolve.

## Component Responsibilities

### `apps/api`

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Root Hono app, global middleware wiring, route mounting; also exports `queue` (the `JOBS` consumer — classification, summary generation, and notification delivery) and `scheduled` (Cron Trigger handler, `CRON_PERIOD_MAP`, fires weekly/monthly business-wide summary jobs) |
| `src/config/env.ts` | Typed `Bindings` interface mirroring `wrangler.toml` |
| `src/db/schema/` | Drizzle table definitions, relations, shared column sets |
| `src/db/client.ts` | Per-request `pg.Client` + Drizzle instance over Hyperdrive |
| `src/db/seed/` | Idempotent seed scripts (permission catalog) |
| `src/repositories/` | One class per entity; only layer that writes SQL/Drizzle queries |
| `src/auth/` | Password hashing, JWT sign/verify, `AuthService`, request DTOs |
| `src/rbac/` | `AuthorizationService` (permission resolution), `RoleProvisioningService` |
| `src/middleware/` | `authenticate`, `resolveTenantContext`, `requirePermission`, `rateLimit`, `auditTrail` |
| `src/businesses/` | `BusinessService` + business routes (create, list, me, audit-log) |
| `src/branches/` | `BranchService` + branch routes (list, create, get, update, delete, QR code get/regenerate) |
| `src/qr/` | `QrCodeService` + `qr.routes.ts` — the platform's only fully public route file (`GET /qr/:token`, `POST /qr/:token/feedback`), no `authenticate`/`resolveTenantContext` anywhere in it |
| `src/feedback/` | `FeedbackService` + authenticated feedback-inbox routes (list, mark reviewed, delete, manual `reanalyze` — re-queues sentiment classification via `sentiment/sentiment-job.ts`) |
| `src/customer-auth/` | `CustomerAuthService`, SMS OTP primitives (`otp.ts`), customer JWT sign/verify (`customer-jwt.ts`), `SmsService`/`TwilioSmsService`/`ConsoleSmsService`, `customer-auth.routes.ts` — the platform's second, parallel identity system, entirely separate from `src/auth/` |
| `src/loyalty/` | `LoyaltyAccountService` (points engine, owns its own `db.transaction()`), `LoyaltyRedemptionService` (same), `LoyaltyTierService`/`LoyaltyRewardService` (thin, repo-injected), `redemption-code.ts`, `loyalty.routes.ts` (staff) + `loyalty-customer.routes.ts` (customer-authenticated — also carries the customer-facing notification-preference routes, see `src/notifications/` below) |
| `src/sentiment/` | `SentimentClassifier` (Workers AI wrapper, `@cf/huggingface/distilbert-sst-2-int8` + a no-inference `classifyRating` fallback for comment-less submissions), `SentimentService` (classify-and-store one feedback row; called from the `JOBS` queue consumer and a manual reanalyze path), `SummaryService` (period aggregation + `SummaryGenerator`-driven text generation, 100-comment prompt cap), `summary-generator.ts` (`SummaryGenerator` interface, `AnthropicSummaryGenerator`, dev-fallback `ConsoleSummaryGenerator`), `period.ts` (`computePeriodRange`/`formatPeriodLabel`), `sentiment-job.ts` (`enqueueSummaryGeneration` — the one place a route touches the `JOBS` binding for this module) |
| `src/analytics/` | `AnalyticsService` (read-only aggregation over `feedback`/`feedback_summaries` — trend/search/listSummaries; deliberately holds no `AI`/Anthropic/`JOBS` binding reference, unlike `src/sentiment/`), `analytics.routes.ts` (`GET /trends`, `GET /search`, `GET /summaries`, `POST /summaries/generate`) |
| `src/notifications/` | `notification-templates.ts` (`renderNotification`, HTML-escaped email bodies), `NotificationService` (preference/kill-switch/cap decision layer), `NotificationDeliveryService` (mechanical send+log, mirrors `SentimentService.classifyAndStore`), `EmailService`/`ResendEmailService`/`ConsoleEmailService`, `notification-job.ts` (`SendNotificationJob`, `enqueueNotification`), `notifications.routes.ts` (staff: self-service preferences, business settings, send log) |
| `src/platform/` | Cross-tenant Platform Admin Console routes/services, none of which mount `resolveTenantContext`: `business-directory.routes.ts` (list/get/team/status-change), `audit-log.routes.ts` (platform-wide, hydrated, filterable), `impersonation.service.ts` (`ImpersonationService`, validates target membership then mints a short-lived non-renewable token), `billing-plans.routes.ts`/`billing-subscriptions.routes.ts` (plan CRUD, cross-tenant subscription list + MRR) |
| `src/billing/` | `stripe-client.ts` (`createStripeClient`/`createWebhookCryptoProvider` -- the one integration in this codebase using the Stripe SDK instead of plain `fetch()`), `subscription-provisioning.service.ts` (card-less trial auto-provisioning, called from `BusinessService.createBusiness`), `billing.service.ts` (business-facing plans/subscription/Checkout/Portal, strips Stripe IDs from every response), `stripe-webhook.service.ts` (event-to-DB sync), `billing.routes.ts` (business-scoped) + `stripe-webhook.routes.ts` (unauthenticated, mounted at root -- see Security Architecture) |
| `src/lib/` | `AppError`, response envelope, global error handler, body validation |

### `apps/web`

| Path | Responsibility |
| --- | --- |
| `src/app/**/page.tsx`, `layout.tsx` | Async Server Components; the only place data is fetched (via `apiFetch()`) |
| `src/app/**/*.tsx` (no special filename) | Co-located Client Components (forms, dialogs, nav) — ignored by the App Router, plain imports |
| `src/lib/actions/` | Server Actions (`'use server'`) — the only mutation path; one file per domain (`auth.ts`, `business.ts`, `branches.ts`) |
| `src/lib/api-client.ts` | `apiFetch()` — the one chokepoint for authenticated `apps/api` calls, with 401-triggered refresh-and-retry |
| `src/lib/session.ts` | httpOnly cookie read/write (`'server-only'`, uses `next/headers`) |
| `src/lib/cookies.ts` | Cookie name constants only — importable from `middleware.ts`, which can't use `next/headers` |
| `src/lib/business.ts` | `getActiveBusiness()` — the one place "which business" is resolved for any dashboard page |
| `src/lib/public-api-client.ts` | `publicApiFetch()` — the anonymous counterpart to `apiFetch()`, for the platform's public write surfaces (QR/feedback submission, customer OTP request/verify); no cookies, no Bearer header, no refresh logic |
| `src/lib/customer-session.ts`, `customer-cookies.ts` | The customer counterpart to `session.ts`/`cookies.ts` — a **separate** httpOnly cookie (`ff_customer_token`), never merged with the staff session module; a single non-rotating 90-day token, no refresh pair |
| `src/lib/customer-api-client.ts` | `customerApiFetch()` — attaches the customer JWT (not the staff access token) to `/loyalty/me/*` calls; no 401-refresh flow, since there is nothing to refresh |
| `src/middleware.ts` | Edge-runtime route protection (refresh-token-cookie presence check); `/feedback` and `/loyalty` are exempted from the staff gate entirely (see Risks — this fixed a pre-existing bug for `/feedback`) |
| `src/components/ui/` | Design system primitives (Button, Input, Textarea, Label, Card, Dialog, StarIcon, StarRating, StarDisplay, Badge, Progress, Switch) |
| `src/app/loyalty/` | Customer-facing pages: `/login` (SMS OTP sign-in), `/[token]` (QR check-in landing), `/dashboard` + `/dashboard/[businessId]` (loyalty cards, tier progress, reward catalog, redemption) + `/dashboard/[businessId]/notifications` (self-service notification preferences) |
| `src/app/dashboard/loyalty/` | Staff-facing pages: accounts (purchase/adjust), `/tiers`, `/rewards`, `/settings`, `/redeem` (counter confirmation tool) |
| `src/app/dashboard/analytics/` | Trend overview (`page.tsx` + `branch-filter.tsx`), AI summaries panel (`summary-generator.tsx`, `summaries-list.tsx`), and `search/` (a separate route: `search-filters.tsx` + `page.tsx`, read-only paginated feedback explorer — kept off the overview page since it's a distinct `analytics:view`-gated surface with no `feedback:manage` actions) |
| `src/components/ui/sentiment-trend-chart.tsx` | Hand-rolled SVG stacked bar chart (no charting library dependency — the chart is a simple 3-series stack, not worth the bundle cost) |
| `src/app/dashboard/notifications/` | Staff dashboard: preferences grid (self-service), business settings (kill switches + SMS cap, `notifications:manage`), send log (`notifications:view`) — one page, three Cards, no subnav (see Changelog N-5) |
| `src/lib/notification-preferences.ts` | Pure grid<->payload helpers used by both the staff and customer preference forms — the one piece of the two forms that IS shared; the stateful components themselves stay independent (different auth system, different Server Action module). Display labels used to live here as static Records but moved to translation lookups in the shared `notifications` message namespace (i18n Block 7 — see below), since `useTranslations()` can't run in a module-level object literal |
| `src/i18n/request.ts` | `getRequestConfig` — resolves the **staff** locale/timezone/formats for the root `NextIntlClientProvider`, gated behind a cheap `hasSession()` check so anonymous requests never pay for a wasted business lookup |
| `src/i18n/load-messages.ts` | `loadMessages(locale)` — dynamically imports all 8 `messages/<locale>/*.json` namespaces per request via next-intl's documented context-module pattern |
| `messages/<locale>/*.json` | One file per feature-module namespace (`common`, `dashboard`, `auth`, `branches`, `feedback`, `loyalty`, `analytics`, `notifications`) × 3 locales (`en`, `es`, `fr`) — 24 files, 373 keys each |
| `src/test-utils.tsx` | `renderWithIntl()` — `NextIntlClientProvider`-wrapped drop-in for React Testing Library's `render()`, required by every Client Component test that touches `useTranslations()`/`useFormatter()`; its `rerender` re-wraps in the same provider rather than exposing RTL's raw one |
| `src/app/platform/` | Platform Admin Console: `layout.tsx` (3-layer gate, explicit access-denied view), `PlatformNav`, business directory (list/detail/status-form/impersonate-button), `audit-log/` (filterable list), `billing/` (MRR summary, subscription list, plan CRUD dialog) |
| `src/app/dashboard/billing/` | Business-facing billing: current-plan card, `plan-card.tsx` (two `useActionState` hooks, one per billing interval), `manage-billing-button.tsx` |
| `src/app/dashboard/impersonation-banner.tsx` | Always-visible warning banner shown only while `isImpersonating()`, with a "Stop" action restoring the admin's stashed real session |
| `src/lib/platform.ts` | `getCurrentUser()` — wraps `GET /auth/me` in React's `cache()` so the layout guard, dashboard home, and impersonation banner share one call per request |
| `src/lib/actions/platform.ts`, `billing.ts`, `platform-billing.ts` | Server Actions for status changes, impersonation start/stop, checkout/portal session creation, and platform plan CRUD |

### `packages/shared-types`

Public API request/response contract (Zod schemas + inferred types), shared
by `apps/api`'s server-side validation and `apps/web`'s client-side form
validation and response typing — never imports from either app, so the two
are free to diverge internally without breaking the shared contract.

## Security Architecture

| Concern | Implementation |
| --- | --- |
| Authentication (staff) | JWT access (15 min) + refresh (30 days, HS256, `hono/jwt`), distinct secrets per type |
| Authentication (customer) | SMS OTP (6-digit, PBKDF2-hashed at 10k iterations — see Password storage below for why that's lower than password strength), single non-rotating JWT (90 days, `CUSTOMER_JWT_SECRET`, entirely separate from staff's `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`). Deliberate scope reduction versus staff auth: no refresh/rotation system, justified by lower stakes (view/redeem own points only, no privilege-escalation surface) |
| OTP abuse controls | 60-second per-phone request cooldown, 5-attempt cap per code (checked before the hash comparison, so a locked-out code stays locked even if guessed correctly afterward), 10-minute expiry, `OTP_RATE_LIMITER` (3/min/IP, stricter than every other limiter since each request costs real Twilio money) |
| Token storage (browser) | Never in `localStorage` or client-readable cookies — `apps/web` holds every token (staff access/refresh, customer access) only as httpOnly, `sameSite=lax` cookies, set by Server Actions, read only by server-side code (BFF pattern, Branch Mgmt Block 3, extended to the customer identity domain in Digital Loyalty Block 5 via a **separate** cookie/session module, never merged with the staff one). Client-side JS has no access to any token under any circumstance |
| CSRF (apps/web) | Next.js Server Actions validate the request `Origin` against allowed origins automatically — no hand-rolled CSRF token needed for the mutation paths this app uses |
| Password storage | PBKDF2-HMAC-SHA256, 600k iterations, native Web Crypto, self-describing hash format. `src/auth/password.ts` exposes generic `pbkdf2Hash`/`pbkdf2Verify` primitives (extracted in Digital Loyalty Block 2) so `customer-auth/otp.ts` reuses the exact same format at a deliberately lower 10k-iteration count — OTP security comes from short expiry + attempt-capping, not offline-hash resistance, so paying the password-grade cost on every SMS code check would only add latency |
| Token theft detection | Refresh tokens hashed at rest, rotated every use; reusing a rotated token is rejected |
| Authorization | RBAC via `user_business_roles` + `role_permissions`; every permissioned route checks one explicit key |
| Input validation | Zod schemas at every route boundary (`parseJsonBody`), rejected input never reaches a service |
| Transport | TLS terminated at Cloudflare edge; `secureHeaders()` middleware on all `/api/v1` responses |
| CORS | Explicit origin allow-list, read from `ALLOWED_ORIGINS` (`[vars]`, comma-separated) at request time — a new environment's origin is a config edit + redeploy, not an `index.ts` code change. Defaults to `localhost:3000` only for local dev; fails closed (empty allow-list) if unset, never wildcard |
| Rate limiting | Cloudflare native binding, IP-keyed: 10/min on auth endpoints, 20/min on the public QR/feedback routes, 3/min on SMS OTP requests (the platform's strictest limiter — real per-request cost via Twilio), 300/min platform-wide; limiters stack |
| Audit trail | Automatic, global middleware; every successful mutating request under `/api/v1` is logged |
| Error disclosure | Unexpected errors never leak stack traces or internal messages to clients |
| Secrets | `wrangler.toml [secrets].required` validated at dev/deploy time; never committed (`.dev.vars` gitignored) |
| SQL injection | Drizzle's parameterized query builder throughout; no raw string-interpolated SQL anywhere in the codebase |
| Enumeration resistance | Login returns an identical error for "no such account" and "wrong password" |
| Analytics access scoping | `analytics:view`/`analytics:manage` are held by Owner/Admin/Manager only — Staff is deliberately excluded from both. Trend/summary data is aggregated business-strategy information, not a front-counter task; Staff retains `feedback:view` for individual submissions |
| Analytics search PII boundary | `GET /analytics/search`'s `keyword` filter matches `comment` only — `customerName`/`customerEmail`/`customerPhone` are excluded from free-text search by construction, so the endpoint can never be used as a customer PII lookup tool |
| AI cost control | `POST /analytics/summaries/generate` is gated by `analytics:manage` (not `:view`) specifically because it costs a real Anthropic API call; the request body accepts only a canned `periodType`, never an arbitrary date range, capping the size (and cost) of any single generation |
| Notifications access scoping | `notifications:view`/`notifications:manage` are held by Owner/Admin/Manager only — Staff is deliberately excluded from both, the same boundary Analytics established. Self-service preference management (own account only) needs **no permission at all**, for either identity system — only business-wide settings and the send log are gated |
| Notification cost control | `business_notification_settings.maxSmsPerDay` (default 50) caps SMS spend per business per day, checked before every SMS enqueue; public unauthenticated feedback submission can trigger an SMS via `feedback_received`, so this exists as a real abuse-cost guard, not a theoretical one. Email/SMS kill switches (`emailEnabled`/`smsEnabled`) provide a platform-wide stop independent of the cap |
| Notification content injection | `notification-templates.ts` HTML-escapes every user-controlled string (business/branch/reward names, feedback comments) before it reaches an email body — feedback comments are public, unauthenticated input, so skipping this would be a real stored-XSS-in-email vector. SMS bodies are plain text and intentionally not escaped (no injection surface) |
| Platform admin authorization | `requirePlatformRole(allowedRoles)` re-resolves `users.platformRole` from the database on every request (never trusted from the JWT), re-checks `status === 'active'` as defense in depth beyond what `authenticate` alone checks, and enforces an explicit per-route allow-list rather than an implied hierarchy — a route scoped to `['billing']` never silently admits `admin` |
| Impersonation | Two membership checks before a token is minted (target user is `active`, and holds an actual role grant at the named business — without the second check an admin could impersonate anyone while claiming an unrelated business, making the session's permissions meaningless); the resulting token is short-lived (30 min) and **non-renewable** (no refresh token pair), carries an `impersonatedBy` claim surfaced to the audit trail, and requires `support`/`admin` specifically (not `billing`). Every request is re-validated and re-logged from scratch on re-initiation rather than silently extending a session |
| Stripe webhook verification | `stripe-webhook.routes.ts` reads the raw request body first (before any global middleware can consume it) and verifies the signature via `stripe.webhooks.constructEventAsync()` before any event data is trusted; an invalid signature is a `400` (never retried by Stripe), while a processing failure after verification is a `500` (Stripe retries) |
| Billing least-privilege | Business-facing billing responses never include a raw Stripe customer/subscription/price ID — `hasPaymentAccount` (derived boolean) replaces `stripeCustomerId` everywhere the frontend needs to know whether "Manage billing" can open. `billing:manage` (change plan, cancel, update payment method) is Owner-only; Admin gets `billing:view` only, the same irreversible/financial-consequence cut already established for `business:delete` |

This covers the OWASP API Security Top 10 categories directly relevant to a
foundation with no business-data endpoints yet (broken auth, broken object-level
authorization, injection, excessive data exposure via unsanitized responses).
Categories not yet applicable — mass assignment on complex nested resources,
SSRF, unrestricted resource consumption beyond rate limiting — will get
explicit review when the modules that introduce that surface area (file
uploads, webhooks, bulk import) ship.

## Scaling Strategy

- **Compute**: Cloudflare Workers scale horizontally at the edge automatically;
  no capacity planning, no server fleet to size.
- **Database**: Hyperdrive pools connections upstream of the Worker, so a new
  `pg.Client` per request is cheap rather than a bottleneck. Neon supports
  autoscaling compute and instant branching for staging/preview environments.
- **No hard-coded limits**: pagination (`limit`/`offset`) exists on list
  endpoints from day one; no fixed caps on businesses, branches, users, or
  roles per tenant anywhere in the schema or application code.
- **Offloadable work**: `UPLOADS` (R2), `CACHE` (KV), and `JOBS` (Queues)
  bindings are provisioned now so future features (sentiment analysis,
  notification delivery) have an async path from day one instead of doing
  that work inline in a request. `UPLOADS` ended up unused by QR Engagement
  specifically — QR codes render client-side from a token + URL, no
  server-side image generation or storage — but stays provisioned for
  receipts/exports and other genuinely file-shaped future features.
- **Read/write split**: not implemented yet. A future consideration once
  reporting/analytics dashboards create read-heavy load distinct from the
  transactional path — Neon read replicas are the natural next step, not a
  redesign.

## Dependencies

### `apps/api`

| Package | Version | Role |
| --- | --- | --- |
| `hono` | ^4.7.0 | HTTP framework (Workers-native) |
| `drizzle-orm` | ^0.45.2 | Type-safe SQL / schema |
| `drizzle-kit` | ^0.31.10 | Migration generation (dev-only) |
| `pg` | ^8.16.3 | Postgres client, used over Hyperdrive |
| `zod` | ^4.4.3 | Request validation |
| `wrangler` | ^4.108.0 | Cloudflare CLI, dev server, deploys |
| `vitest` | ^3.1.3 | Unit/integration test runner |
| `@cloudflare/vitest-pool-workers` | ^0.8.0 | Workers-runtime test pool (version unconfirmed — verify against npm before relying on it) |
| `stripe` | ^22.2.1 | Platform SaaS billing (Checkout, Customer Portal, webhook verification) — the one third-party integration in this codebase using the official SDK rather than plain `fetch()`, since Cloudflare/Stripe jointly document native Workers support. `apiVersion` pinned to `2026-05-27.dahlia`, not independently confirmed against Stripe's dashboard this session — verify before production (see Risks) |

### `apps/web`

| Package | Version | Role |
| --- | --- | --- |
| `next` | ^16.2.0 | Framework, App Router, deployed via OpenNext |
| `react` / `react-dom` | ^19.0.0 | `useActionState`, Server Components/Actions |
| `@opennextjs/cloudflare` | ^1.20.1 | Deploys Next.js to Workers |
| `@base-ui-components/react` | ^1.0.0-beta.0 | Headless UI primitives (Dialog) — verified exact via npm; chosen over Radix for broader coverage and more active maintenance as of mid-2026, at the cost of being pre-1.0. Import is contained to `components/ui/dialog.tsx` so swapping libraries later is a one-file change |
| `tailwindcss` / `@tailwindcss/postcss` | ^4.1.0 (estimate) | CSS-first design tokens (`@theme` in `globals.css`), no `tailwind.config.js` |
| `class-variance-authority` | ^0.7.1 (estimate) | Typed component variant props (Button) |
| `clsx` / `tailwind-merge` | ^2.1.1 / ^3.0.0 (estimates) | Combined into the `cn()` helper (`lib/utils.ts`) |
| `server-only` | ^0.0.1 | Build-time guard preventing token-handling code (`session.ts`, `api-client.ts`) from ever reaching a client bundle |
| `react-qr-code` | ^2.2.0 | SVG QR code rendering for the QR management dialog (QR Engagement Block 4) — live-searched against `qrcode.react`/`qr-code-styling` before adding; SVG-only fits codes meant to be printed, and the narrower API carries no unused logo/branding surface |
| `next-intl` | ^4.13.1 | UI translation (en/es/fr) + Intl-backed date/number/currency formatting (i18n & Multi-Currency module) — used in next-intl's documented "without i18n routing" mode, since locale here is a business setting, not a per-visitor URL choice |
| `vitest` | ^3.1.3 | Component/logic test runner, matches `apps/api`'s version |
| `@vitejs/plugin-react`, `vite-tsconfig-paths`, `jsdom` | ^4.3.4 / ^5.1.4 / ^25.0.1 (estimates) | Vitest's React JSX transform, `@/*` path alias resolution, DOM environment |
| `@testing-library/react`, `/dom`, `/jest-dom`, `/user-event` | ^16.1.0 / ^10.4.0 / ^6.6.3 / ^14.5.2 (estimates) | Component rendering, DOM matchers, realistic user interaction simulation |
| `@playwright/test` | ^1.49.1 (estimate) | E2E test runner |

Versions marked "estimate" were not individually re-verified against npm this
session (all of them are common, stable packages where a recent caret range
is low-risk) — confirm on first `pnpm install` per each app's own risk note
in [Risks & Known Gaps](#risks--known-gaps).

External services: **Neon** (Postgres hosting), **Cloudflare** (Workers, Hyperdrive,
R2, KV, Queues, Rate Limiting, DNS/TLS), **Resend** (transactional email, Notifications
module — plain `fetch()` to its REST API, no SDK dependency), **Twilio** (SMS, both
OTP delivery and notification delivery, same reasoning), **Stripe** (platform SaaS
billing — Checkout, Customer Portal, subscription webhooks; Platform Admin Console
Block 8, the one external service reached via SDK rather than `fetch()`).

**REST over GraphQL**: chosen for the foundation because Cloudflare's rate
limiting, caching, and observability primitives all key off REST's
method+path shape, and there's no query-complexity/DoS surface to manage.
Revisit if a future frontend (e.g. a mobile app needing flexible field
selection) makes REST's fixed response shapes genuinely costly.

## Risks & Known Gaps

| Risk | Status | Mitigation / Next step |
| --- | --- | --- |
| CORS allows only `http://localhost:3000` by default | Fixed (mechanism), Open (values) | `ALLOWED_ORIGINS` (`[vars]`, comma-separated, `config/env.ts`'s `Bindings`) replaced the hardcoded array in `src/index.ts` — adding an origin is now a `wrangler.toml` edit + redeploy, not an application-code change. Still nobody's set it to a real deployed origin yet, since nothing is deployed — not on the critical path for `apps/web` itself, which uses the BFF pattern instead; only relevant for a hypothetical direct-browser API consumer |
| `wrangler.toml` has placeholder Hyperdrive/R2/KV/rate-limiter IDs | Open | Run the provisioning commands in [SETUP.md](./SETUP.md), paste real IDs in |
| No code in this project has been executed (installed, typechecked, or tested) | Open | The sandbox environment used to build this project had a persistent host-level failure for its entire session; run `pnpm install && pnpm typecheck && pnpm test` (both apps) locally as the first verification step |
| `@cloudflare/vitest-pool-workers` and most `apps/web` devDependency versions are estimates, not individually confirmed against npm | Open | Confirm/pin exact versions on first local `pnpm install` in each app |
| `apps/web`'s Playwright E2E suite is a single smoke test, never executed | Open | Run `pnpm test:e2e` against a real migrated + seeded database as the next verification step once `pnpm install`/`pnpm test` pass |
| No Select/Combobox primitive in the design system | Open | Branch form's country-code/timezone fields are plain text inputs as a result; add a real primitive (~250 countries / ~400 IANA zones, searchable) before more forms need this |
| No business switcher UI | Accepted for now | No team-invite flow exists yet, so no user can belong to more than one business in practice — revisit alongside a future team-management module, not before |
| Permission-aware UI (hiding controls a user lacks permission for) not wired up anywhere in `apps/web` | Accepted for now | Structurally impossible to need yet — creating a business is still the only way to gain membership in one, always as Owner with every permission; revisit alongside the same future team-management module |
| No read replica / caching layer yet | Accepted for now | Revisit when analytics/reporting read load justifies it |
| `createdBy`/`updatedBy`/`deletedBy` columns have no FK constraint to `users` | Accepted, deliberate | Avoids a self-referencing `users` table and cross-table migration-order coupling; enforced at the repository layer instead |
| `apiFetch()` has no concurrent-401-refresh deduplication | Open | If the access token is expired at the exact moment two `apiFetch` calls fire concurrently (first introduced by `dashboard/feedback/page.tsx`'s `Promise.all`, QR Engagement Block 5), both could independently hit `/auth/refresh`; since refresh tokens rotate on use, the losing request can get rejected on an already-rotated token. Low real impact today (one failed fetch, recoverable by reload) — add a single-flight refresh lock in `api-client.ts` if more concurrent-`apiFetch` pages make this matter more |
| `GET /api/v1/qr/:token`'s smoke test needs real Hyperdrive to pass | Open | Unlike the 401-only smoke tests, this route has no early-return middleware before it queries — same general gap as the rest of `test:workers`, not new here |
| `middleware.ts` never exempted `/feedback` from the staff-session gate — a genuine pre-existing bug, found and fixed while adding Digital Loyalty's `/loyalty` public routes | Fixed (Digital Loyalty Block 5) | `PUBLIC_PATHS` now includes both `/feedback` and `/loyalty`; the "logged-in staff gets redirected off an auth page" check is now scoped to `STAFF_AUTH_PATHS` (`/login`, `/signup`) only, not every public path — a signed-in staff member can still view a public feedback/loyalty page without being bounced to `/dashboard` |
| No E2E coverage of the customer-facing SMS OTP flow (check-in, redemption) | Open | `ConsoleSmsService` logs the OTP code to the API dev server's stdout in non-production, but Playwright's `webServer` config has no reliable way to read that log back out mid-test. `e2e/loyalty.spec.ts` covers the staff-side setup flow (tiers/rewards/settings) only. Recommended follow-up: a dev-only endpoint returning the last issued code for a phone, gated behind `ENVIRONMENT !== 'production'` the same way `ConsoleSmsService` itself is |
| No referral-code endpoint | Open | `LoyaltyAccountService.enroll()` fully supports `referredByCustomerId` and correctly awards the referrer, but no public route exposes a safe way to pass it — a raw customer UUID isn't fit for a shareable link. Needs a short, non-guessable referral-code scheme mapped back to a customer, not built yet |
| Birthday bonuses are configurable but never triggered | Open | `loyalty_settings.birthdayBonusPoints` exists and `loyalty_transactions.type` includes `'birthday_bonus'`, but nothing reads a customer's `birthday` and fires the transaction — needs a scheduled job (the `JOBS` Queue binding is provisioned and unused for this) |
| `LoyaltyAccountService`/`LoyaltyRedemptionService` have no fake-repo unit tests | Accepted, deliberate | Both own a `db.transaction()` directly (see Layered Architecture's dependency-direction note) — a fake `Database.transaction()` can't meaningfully verify atomic delta application + tier recalculation + ledger insert, so their real behavior is covered by `test/integration/loyalty-*.integration.test.ts` against a real Postgres instead, same reasoning `PermissionRepository.findEffectiveKeys` already established for join-heavy logic |
| No polling/notification for async summary generation | Open | `POST /analytics/summaries/generate` returns `202` once the job is enqueued, not once it completes; `summary-generator.tsx` shows a static "Queued — refresh shortly" message with no polling, websocket, or push notification when the job actually finishes. A user must manually reload `/dashboard/analytics` to see the result. Acceptable for a first release since generation typically completes in seconds, but revisit with polling or a toast-on-complete mechanism if latency grows |
| No per-branch automatic scheduled summaries | Open | `src/index.ts`'s `scheduled` export (Cloudflare Cron Trigger, `wrangler.toml`'s `[triggers]`) already fires a **business-wide** `generate_summary` job for every business, weekly (Monday 00:00 UTC) and monthly (1st, 00:00 UTC) — this is built and working, not a gap. What's missing is a per-*branch* schedule; a branch's own rollup only happens via an explicit staff `POST .../generate` call with a `branchId`. `feedback_summaries.branchId`'s nullability and `SummaryService` already support this if it's ever needed — no schema/service change required, only a change to what the cron handler enqueues |
| Fake-repository casting pattern differs from `branch.service.test.ts`'s precedent | Accepted, deliberate | `BranchRepository`'s test fake happened to implement its full method set, so it satisfied `Pick<Repositories, 'branches'>` with no cast. `FeedbackRepository`/`FeedbackSummaryRepository`/`BusinessRepository`/`BranchRepository` all have far more methods than the Sentiment Analytics services touch, so their fakes only implement a subset and must be cast `as unknown as <RepositoryClass>` at each service-constructor call site (`sentiment.service.test.ts`, `analytics.service.test.ts`, `summary.service.test.ts`); `vi.mocked(fn)` re-establishes Mock typing afterward wherever `.mock.calls` is accessed on a casted value. Document this as the expected pattern for any future service whose repository dependency has more methods than the service actually calls |
| Push notifications not implemented | Open | `notificationChannelSchema` enumerates `push` for forward-compatibility, but `NotificationDeliveryService` has no delivery implementation for it — `DELIVERABLE_NOTIFICATION_CHANNELS` (email, sms only) is what every route, `NotificationService`, and the preferences UI actually offer. Add a `PushService` (Web Push or a mobile-push provider, TBD) and extend that one constant once a channel exists to actually deliver through |
| Resend chosen over Cloudflare's native Email Service binding | Accepted for now | Cloudflare shipped a native Email Service binding shortly before Notifications was built (public beta, no API key needed, cheaper than Resend) — architecturally preferable long-term (one fewer external service, matches this project's Cloudflare-native bias everywhere else), but too new at the time to trust for a platform whose own standing instructions demand "enterprise-grade" reliability. `EmailService` is a one-file interface (`src/notifications/email.service.ts`) specifically so this swap stays contained whenever the binding has more production track record |
| `Queue<PlatformJob>` contravariant typing never verified by an actual compiler run | Open | Widening `Bindings.JOBS` to `Queue<SentimentJob \| SendNotificationJob>` while each domain's own `enqueueX()` helper stays narrowly typed to its own single job type relies on TypeScript's contravariant function-parameter assignability — standard, well-defined behavior, but this project's sandbox has been unavailable for every block across every module, so no `pnpm typecheck` has actually run against this. First thing to check once local tooling is available |
| `feedback_summaries` (AI Sentiment Analytics, SA-1) was never added to [ERD.md](./ERD.md) | Open | Found while documenting Notifications' own 3 new tables in ERD.md — SA-7's docs pass updated API.md and this file but never touched ERD.md at all, unlike every other module's docs block. Out of scope to fix here (a different module's table, not Notifications'); needs its own small addition (diagram entry + field table, mirroring `feedback`'s or `loyalty_settings`'s existing entries) whenever ERD.md is next touched |
| `SUPPORTED_LOCALES` is a closed 3-value enum (`en`/`es`/`fr`), not open BCP-47 | Accepted, deliberate | `default_locale` drives both Intl formatting AND UI string lookup — an untranslated tag would silently half-localize a business (correct number formats, English-only text). Enforced at both the Zod (`localeSchema`) and database (`businesses_default_locale_check`) layers. Trade-off: adding a language needs a real `messages/<locale>/*.json` set (8 namespace files) plus edits to `SUPPORTED_LOCALES` and the CHECK constraint — a code deploy + migration, not a runtime-configurable list |
| `packages/shared-types` has no test runner of its own | Open | No `vitest` dependency, no config, zero tests for any export in the package — not new to this module, but surfaced while adding coverage for `resolveSupportedLocale` (i18n Block 8), which had none since it was introduced. Covered instead from `apps/web` (its main consumer, with a working Vitest setup already) at the integration boundary; revisit if `shared-types` grows enough pure logic to justify its own test infra rather than relying on consumers |
| `feedback/[token]/not-found.tsx` cannot render in a QR's own business locale | Accepted, deliberate | The only reason this route renders at all is that the scanned token *never resolved* to a business — there is no `defaultLocale` signal left to read at that point, unlike every other anonymous QR page. Falls back to the root default locale (English) by design, documented in-code rather than worked around |
| i18n test coverage not confirmed against a real test run | Open | `resolve-supported-locale.test.ts`/`load-messages.test.ts` (new) and the `renderWithIntl` swap across 13 existing test files were written and reviewed by hand only — this session's sandbox was unavailable for its entire duration (see the top-level gap below), so `pnpm test`/`pnpm typecheck` in `apps/web` have not actually run against any of this module's changes |
| No abuse-response tooling beyond suspend/reactivate/archive | Open | The Future Expansion roadmap item that seeded this module named "abuse response" alongside support/billing; only business status changes (`PATCH /platform/businesses/:id/status`) shipped. No rate-limit override, IP block, or content-takedown tooling exists yet — add if/when a real abuse case makes the gap concrete rather than speculative |
| Stripe `apiVersion` (`2026-05-27.dahlia`) pinned without independent confirmation | Open | Chosen based on Stripe/Cloudflare's documented Workers-compatible integration path; not cross-checked against Stripe's dashboard or changelog this session (sandbox unavailable). Confirm the pinned version is still valid and matches the connected Stripe account before processing any real payment |
| MRR calculation assumes a single reporting currency | Accepted, deliberate | `BusinessSubscriptionRepository.calculateMrr()` sums raw cents across active subscriptions with no FX conversion — true of the seed catalog (all USD) but not a general multi-currency solution. Revisit with either a fixed reporting currency + live conversion, or a per-currency breakdown, if/when a non-USD-priced plan is added — flagged in `platformMrrSummarySchema`'s own comment, not silently assumed |
| Stripe webhook idempotency is upsert-construction, not an event-ID ledger | Accepted, deliberate | `business_subscriptions` is a pure state mirror (`ON CONFLICT (business_id) DO UPDATE`), so replaying the same Stripe event twice reapplies identical state — safe by construction. This would NOT be safe for anything that increments a value (e.g. loyalty points on payment); revisit with a real `stripe_events` dedup table only if a future webhook handler needs that stronger guarantee |
| Suspended/deactivated users keep using a still-valid access token on ordinary business routes | Open, pre-existing | `authenticate` alone never checks `users.status`; only the new `requirePlatformRole` does (added as defense in depth specifically because platform routes are the highest-blast-radius surface). A suspended business's staff member with an unexpired 15-minute access token can still hit ordinary tenant routes until it naturally expires. Not introduced by this module, but surfaced while writing `requirePlatformRole`'s own code comment — worth a platform-wide fix (check status in `authenticate` itself) rather than a per-middleware patch |
| Platform Admin Console test coverage is unit + one integration suite, not end-to-end | Open | `SubscriptionProvisioningService`/`BillingService`/`StripeWebhookService` have fake-repo unit tests and `billing-permissions.integration.test.ts` covers the Owner/Admin permission cut against real Postgres — but no test exercises a real Stripe Checkout session or a live webhook delivery (would require Stripe test-mode credentials and either the Stripe CLI or a tunneled endpoint, neither set up this session). Recommended before production: a manual Stripe CLI (`stripe listen --forward-to`) pass against a running dev server |

## Assumptions

- A business's default locale/currency/timezone (set at creation) are
  sufficient starting defaults for its branches; per-branch overrides exist in
  the schema (`branches.timezone`) but per-branch locale/currency do not yet —
  add if a real multi-country pilot needs it.
- One Postgres instance (Neon) serves all tenants for the foreseeable term;
  sharding is not designed for and should not be assumed by future code.
- The web app (`apps/web`) is the only first-party API consumer for now;
  the CORS allow-list model (rather than a public API-key model) assumes that.
  A public/partner API will need a separate auth mechanism (API keys or OAuth
  client credentials), not an extension of the browser-session JWT flow.

## Future Expansion

Planned feature modules, each building on this foundation without modifying it:

1. ~~**Branch management UI** — CRUD over `branches`.~~ **Done** (Branch
   Management module, Blocks 1-7) — the first module built on this
   foundation, and the one that introduced `apps/web`'s entire frontend
   architecture (see "Layered Architecture (apps/web)" above). Remaining
   related work is tracked as accepted gaps above (business switcher,
   permission-aware UI), not open items here.
2. ~~**QR engagement module** — per-branch QR code generation, scan-to-
   feedback landing flow.~~ **Done**, merged with item 3 below into one
   module (QR Engagement, Blocks 1-7) — a QR code landing on a placeholder
   page delivers no value, so the two were combined into one vertical
   slice rather than shipped as two separate future modules. Real deviation
   from this line's original wording: QR images are **not** stored in R2 —
   no server-side image generation exists at all; a QR code is just a
   token + URL, rendered client-side. Loyalty/promotion check-in QR types
   remain future work (`qr_codes.type` exists for this, unconstrained).
3. ~~**Feedback & reviews** — new tenant-scoped tables (`feedback`,
   `ratings`), reuses `branches`/`businesses`/audit conventions as-is.~~
   **Done** as part of QR Engagement (one `feedback` table, not two) — see
   item 2.
4. ~~**AI sentiment analytics** — async pipeline via the existing `JOBS` queue
   binding; summaries and trend dashboards read from precomputed rollup
   tables, not live inference on every dashboard load.~~ **Done** (AI
   Sentiment Analytics module, Blocks 1-8) — Workers AI classification
   (`@cf/huggingface/distilbert-sst-2-int8`) on submit, async via the `JOBS`
   queue; day-bucketed trend chart, AI-generated weekly/monthly period
   summaries (Anthropic Messages API), and a searchable/filterable feedback
   explorer, all gated behind new `analytics:view`/`analytics:manage`
   permissions that deliberately exclude Staff. Summaries are generated both
   ways: on-demand via an explicit staff action (`POST .../generate`) and
   automatically via a Cloudflare Cron Trigger (`src/index.ts`'s `scheduled`
   export, weekly + monthly, business-wide only) — matching this line's
   original "precomputed rollup tables, not live inference" wording more
   closely than a purely on-demand design would have. Real deviation: the
   automatic schedule only produces business-wide rollups, not one per
   branch — see Risks & Known Gaps.
5. ~~**Digital loyalty** — membership cards, points, tiers, redemptions.~~
   **Done** (Digital Loyalty module, Blocks 1-8) — SMS-OTP customer identity
   (a second, parallel identity system, see Multi-Tenancy Model), a
   transactional points engine with automatic tier recalculation, a
   two-phase reward redemption flow (customer spends points for a code,
   staff confirms the physical handoff), and full customer- and
   staff-facing UI. Real deviations from this line's original wording: no
   `branch_id` scoping on loyalty data (accounts/transactions are
   business-wide, not per-branch — a customer's points follow them across a
   business's branches, only `checkin` transactions record *which* branch's
   QR code was scanned via `related_qr_code_id`); birthday bonuses and
   referral codes are designed (schema + settings exist) but not fully wired
   up — see Risks & Known Gaps.
6. ~~**Notifications** — consumer for the `JOBS` queue (email/SMS/push);
   currently only the producer side (`JOBS` binding) exists.~~ **Done**
   (Notifications module, Blocks 1-7) — email (Resend) and SMS (reusing
   Digital Loyalty's `SmsService` unchanged) delivery for 6 transactional
   events (3 staff-facing, 3 customer-facing), self-service preferences for
   both identity systems, business-wide kill switches plus a daily SMS cost
   cap, and a send log — gated behind new `notifications:view`/`:manage`
   permissions that deliberately exclude Staff, the same boundary Analytics
   established. Real deviation from this line's original wording: **push is
   not implemented** — enumerated in the channel schema for
   forward-compatibility only, see Risks & Known Gaps. Every trigger fires
   from a route handler strictly after its owning operation's transaction
   has already committed, never from inside a `db.transaction()`-owning
   service, avoiding a dual-write race between the DB commit and the queue
   send.
7. ~~**i18n/multi-currency UI layer** — `businesses.default_locale` /
   `default_currency` already exist for this; the web app's rendering layer
   does not yet consume them.~~ **Done** (Internationalization &
   Multi-Currency UI module, Blocks 1-9) — full English/Spanish/French UI
   translation (not just number/date formatting) across every staff and
   customer screen, a three-context `next-intl` provider architecture (staff,
   customer, anonymous QR), and a database-enforced closed locale enum. Real
   deviation from this line's original wording: `default_locale` was
   previously an unrestricted text column; this module added a
   `businesses_default_locale_check` CHECK constraint restricting it to
   `'en' | 'es' | 'fr'` specifically, not open BCP-47 — see Risks & Known
   Gaps for the resulting "extending the language list needs a code deploy"
   trade-off.
8. ~~**Platform admin console** — cross-tenant operations (support, billing,
   abuse response) need their own permission tier above business-scoped RBAC;
   not designed yet, flag before building customer-facing billing.~~ **Done**
   (Platform Admin Console module, Blocks 1-12) — `users.platformRole`
   (support/billing/admin, layered on top of business-scoped RBAC, not a
   replacement for it), a cross-tenant business directory + platform-wide
   audit log, time-boxed non-renewable impersonation with a target-side
   warning banner and an admin-token-stash exit path, and a full
   Stripe-backed platform SaaS billing system (card-less trials, hosted
   Checkout/Portal, signature-verified webhook sync, plan catalog CRUD, a
   real SQL MRR aggregate). Real deviation from this line's original
   wording: **no abuse-response tooling** beyond business status changes
   (suspend/reactivate/archive) shipped — see Risks & Known Gaps. This was
   the last item on the roadmap; all originally-planned feature modules are
   now complete.

## Changelog

| Block | Date | Summary |
| --- | --- | --- |
| 1 | 2026-07-08 | Monorepo scaffold: pnpm workspaces, `apps/api` (Hono), `apps/web` (Next.js via OpenNext), `packages/shared-types`, shared tooling (ESLint, Prettier, TS) |
| 2 | 2026-07-08 | Environment/config management; Neon selected as Postgres provider; `wrangler.toml [secrets].required` adopted |
| 3 | 2026-07-08 | Database schema: `businesses`, `branches`, `users`, `roles`, `permissions`, `role_permissions`, `user_business_roles`, `audit_log` |
| 4 | 2026-07-08 | `db/client.ts` (Hyperdrive + Drizzle pattern), repository layer, one class per entity |
| 5 | 2026-07-08 | Auth core: PBKDF2 password hashing, JWT access/refresh, `refresh_tokens` table with rotation |
| 6 | 2026-07-08 | RBAC middleware chain, `BusinessService`, `RoleProvisioningService`, default role seeding |
| 7 | 2026-07-08 | API layer skeleton: response envelope, `AppError`, native Cloudflare rate limiting, CORS, request validation |
| 8 | 2026-07-08 | Automatic global audit logging middleware, `audit:view` permission |
| 9 | 2026-07-08 | Three-tier test setup: plain-Node unit tests, Postgres integration tests, Workers-pool smoke tests |
| 10 | 2026-07-08 | Documentation (this set); fixed 3 middleware handlers (`authenticate`, `resolveTenantContext`, `requirePermission`) that returned ad hoc `{ error: string }` responses instead of throwing `AppError` — found while writing [API.md](./API.md), now fully consistent with the standard envelope |
| — | 2026-07-08 | **Multi-Tenant Foundation complete.** Branch Management (feature module 1) begins; block numbering resets per module below |
| BM-1 | 2026-07-08 | Branch API: `branch.routes.ts` + `BranchService` over the pre-existing `BranchRepository`. First real content in `packages/shared-types` (`createBranchSchema`, `branchSchema`, `slugSchema`) |
| BM-2 | 2026-07-08 | `apps/web`'s frontend foundation: Tailwind v4 design tokens, 5 UI primitives (Button, Input, Label, Card, Dialog on Base UI) |
| BM-3 | 2026-07-08 | BFF auth pattern: Server Actions + httpOnly cookies, `apiFetch()`'s refresh-and-retry, Edge middleware route protection |
| BM-4 | 2026-07-08 | Dashboard shell; `GET /businesses` added (a real gap — no prior endpoint answered "which businesses does this user belong to") |
| BM-5 | 2026-07-08 | Branch management screens (list/create/edit/delete), `getActiveBusiness()` extracted to avoid duplicating Block 4's fetch logic |
| BM-6 | 2026-07-08 | Testing: backend `branch.service.test.ts` + a DB-constraint integration test; `apps/web`'s first test infrastructure (Vitest/RTL + Playwright), previously nonexistent |
| BM-7 | 2026-07-08 | Documentation (this update): `apps/web`'s architecture formally added to this document (previously backend-only); full branch endpoint reference in [API.md](./API.md); env var correction in [SETUP.md](./SETUP.md) |
| — | 2026-07-08 | **Branch Management complete.** QR Engagement (feature module 2) begins; block numbering resets again below. Scope decided via AskUserQuestion: merged the roadmap's separate "QR engagement" and "Feedback & reviews" items into one vertical slice |
| QR-1 | 2026-07-08 | Schema: `qr_codes` (partial unique index enforcing one active code per branch) + `feedback` tables, 2 new permissions (`feedback:view`/`feedback:manage`) |
| QR-2 | 2026-07-08 | Backend API: `src/qr/` (fully public routes) + `src/feedback/` (authenticated inbox) + branch-nested QR management routes; new `PUBLIC_RATE_LIMITER` binding |
| QR-3 | 2026-07-08 | Public feedback landing page (`apps/web`'s `/feedback/[token]`); new `publicApiFetch()` (the anonymous counterpart to `apiFetch()`); `StarRating` design-system primitive |
| QR-4 | 2026-07-08 | QR code display/regenerate dialog on the branches list; `react-qr-code` added; scannable URL built from `window.location.origin`, no new env var |
| QR-5 | 2026-07-08 | Feedback inbox UI (`/dashboard/feedback`); `StarIcon`/`StarDisplay`/`Badge` primitives; native-`<select>` branch filter; found and flagged (not fixed) `apiFetch`'s concurrent-401-refresh gap |
| QR-6 | 2026-07-08 | Testing: backend fakes + a DB-constraint integration test for the partial unique index + 2 more `test:workers` smoke tests; frontend component/unit tests; one E2E test covering the full scan-to-inbox loop |
| QR-7 | 2026-07-08 | Documentation (this update): full endpoint reference for 7 new routes in [API.md](./API.md); `qr_codes`/`feedback` added to [ERD.md](./ERD.md) (skipped in BM-7 — Branch Management added no tables, this module did); `PUBLIC_RATE_LIMITER` provisioning note and stale R2 comment fixed in [SETUP.md](./SETUP.md); Future Expansion items 2-3 marked done |
| — | 2026-07-09 | **QR Engagement complete.** Digital Loyalty (feature module 3) begins; block numbering resets again below. User selected SMS OTP over the recommended no-verification option for customer identity (`AskUserQuestion`), driving Blocks 1-2's design |
| L-1 | 2026-07-09 | Schema: `customers` (global identity), `otp_codes`, `loyalty_tiers`, `loyalty_rewards`, `loyalty_accounts`, `loyalty_transactions`; 3 new permissions (`loyalty:view`/`loyalty:manage`/`rewards:manage`) |
| L-2 | 2026-07-09 | Customer identity & OTP verification: generic `pbkdf2Hash`/`pbkdf2Verify` extracted from `auth/password.ts`; `src/customer-auth/` (SMS service with dev-mode console fallback, OTP primitives, customer JWT, `CustomerAuthService`, public routes); new `customerAuthenticate` middleware and `OTP_RATE_LIMITER` binding |
| L-3 | 2026-07-09 | Points engine: `LoyaltyAccountService` (transactional check-in/purchase/adjustment with automatic tier recalculation); added `loyalty_settings` table (not originally in Block 1's schema — only became clear the engine needed configurable earning rates once writing it) |
| L-4 | 2026-07-09 | Rewards & redemption: `LoyaltyTierService`/`LoyaltyRewardService` (config CRUD), `LoyaltyRedemptionService` (two-phase redeem-then-confirm), 8-char human-typeable redemption codes distinct from OTP's numeric alphabet |
| L-5 | 2026-07-09 | Customer-facing UI (`apps/web/src/app/loyalty/`): SMS OTP sign-in, QR check-in landing page, loyalty dashboard with tier progress + reward catalog + redemption. New `customer-session.ts`/`customer-api-client.ts` (separate from staff's). Found and fixed a pre-existing bug: `middleware.ts` never exempted `/feedback` from the staff-session gate |
| L-6 | 2026-07-09 | Staff-facing UI (`apps/web/src/app/dashboard/loyalty/`): accounts list (purchase/adjust), tiers, rewards, settings, redemption-confirmation counter tool. New `Progress` design-system primitive; `LoyaltyAccountRepository.listForBusiness` extended to join customer phone/name |
| L-7 | 2026-07-09 | Testing: fake-repo unit tests for every repo-injected service + OTP/JWT primitives; 2 new `test/integration/loyalty-*` suites for the two transaction-owning services; `test/workers/loyalty.test.ts` (route mounting + dual-auth-gate smoke tests); frontend component tests; `e2e/loyalty.spec.ts` (staff setup flow — customer OTP flow flagged as a gap, not silently skipped) |
| L-8 | 2026-07-09 | Documentation (this update) |
| — | 2026-07-09 | **Digital Loyalty complete.** AI Sentiment Analytics (feature module 4) begins; block numbering resets again below |
| SA-1 | 2026-07-09 | Schema: `feedback.sentiment`/`sentimentScore`/`analysisStatus`/`analyzedAt` columns; new append-only `feedback_summaries` table (nullable `branchId` distinguishes business-wide from per-branch rollups); 2 new permissions (`analytics:view`/`analytics:manage`) |
| SA-2 | 2026-07-09 | Classification pipeline: `SentimentClassifier` (Workers AI binary classifier + neutral-band bucketing, deterministic rating-only fallback), `SentimentService` (classify-and-store, idempotent), `JOBS` queue consumer wired in `src/index.ts` |
| SA-3 | 2026-07-09 | Summary generation: `SummaryService`, `SummaryGenerator` interface (`AnthropicSummaryGenerator` + dev-fallback `ConsoleSummaryGenerator`), `period.ts`, 100-comment prompt cap; also added `src/index.ts`'s `scheduled` export (Cloudflare Cron Trigger, weekly Monday + monthly 1st, business-wide only) so summaries are precomputed on a schedule, not purely on-demand — easy to miss since it lives in `index.ts` rather than `src/sentiment/`, and this session's SA-7 doc pass initially did miss it (see SA-8) |
| SA-4 | 2026-07-09 | Read API: `src/analytics/` (`AnalyticsService` + 4 routes — trends/search/summaries/generate), `INVALID_DATE_RANGE`/`DATE_RANGE_TOO_LARGE` error codes, 366-day range cap; also added `feedback.routes.ts`'s `POST /:id/reanalyze` (manual re-queue for a failed/stale classification, `feedback:manage`) |
| SA-5 | 2026-07-09 | Dashboard UI: trend chart (hand-rolled SVG, no new dependency), AI summaries panel (non-destructive generation, no confirm dialog), searchable feedback explorer as a separate route (distinct permission surface from the feedback inbox); `Badge`'s `success`/`danger` variants added for sentiment-count display |
| SA-6 | 2026-07-09 | Testing: backend fake-repo unit tests for all 4 sentiment/analytics services (established the cast-when-fake-is-partial pattern — see Risks & Known Gaps), frontend component tests including this codebase's first `next/navigation` `useRouter` mock |
| SA-7 | 2026-07-09 | Documentation: full endpoint reference for the 4 analytics routes + 2 new error codes + 2 new permissions in [API.md](./API.md); Component Responsibilities, Security Architecture, Risks & Known Gaps, and Future Expansion item 4 updated here |
| SA-8 | 2026-07-10 | **Review pass**, triggered by explicit user request after SA-7 marked the module complete — caught 3 real inaccuracies introduced or missed by SA-7's docs pass, all fixed: (1) API.md and this file both wrongly claimed no scheduled summary generation existed, when SA-3's `scheduled` export already covers business-wide weekly/monthly rollups — corrected to the narrower, real gap (no *per-branch* auto-schedule); (2) `POST /feedback/:id/reanalyze` (SA-4) was completely undocumented in API.md — added; (3) [SETUP.md](./SETUP.md) never received its own Sentiment Analytics pass at all — was missing the `ANTHROPIC_API_KEY` secret command, the `echo-grid-feedback-jobs-dlq` provisioning command, and the `.dev.vars` example line, same "stale doc copy" pattern as Branch Mgmt Block 7 and QR Engagement Block 2. Also corrected an overstated README/memory claim that `search-filters.test.tsx` was the first component to use client-side navigation — `BranchFilter` (QR Engagement Block 5) already did; it's the first *test* to mock `useRouter`. No code changes — sandbox was unavailable all pass (typecheck/tests could not be executed), so verification was manual: read every sentiment/analytics service, repository, route, and UI file end to end and cross-checked each against its own doc claims |
| — | 2026-07-10 | **AI Sentiment Analytics complete,** review pass included. |
| — | 2026-07-10 | Notifications (feature module 5) begins; block numbering resets again below. Selected over i18n/multi-currency UI and a platform admin console via `AskUserQuestion` |
| N-1 | 2026-07-10 | Schema: `notification_preferences` (nullable `userId`/`customerId`, CHECK enforcing exactly one set, **two** partial unique indexes rather than one combined index — Postgres treats `NULL != NULL` in uniqueness checks, so a single index over both nullable columns would silently fail to prevent duplicates on whichever side is null), `notifications` (append-only send log, snapshots `recipientAddress` at send time), `business_notification_settings` (lazy get-or-create, email/SMS kill switches + `maxSmsPerDay` cap, default 50); 2 new permissions (`notifications:view`/`notifications:manage`, Owner/Admin/Manager only) |
| N-2 | 2026-07-10 | Delivery infrastructure: `EmailService` (`ResendEmailService` + dev-fallback `ConsoleEmailService`, plain `fetch()`, no SDK — same Workers-runtime-compatibility reasoning as Twilio/Anthropic), `SmsService` reused completely unchanged from Digital Loyalty, `SendNotificationJob` + `NotificationDeliveryService` (mechanical send+log, mirrors `SentimentService.classifyAndStore`), `PlatformJob` union widening `JOBS`'s type rather than a second queue. Live-searched the transactional-email landscape first: chose Resend over Cloudflare's new native Email Service binding (shipped public beta shortly before this block) specifically because the binding was too new to trust for this platform's "enterprise-grade" bar — flagged in Risks as a one-file, revisitable swap |
| N-3 | 2026-07-10 | Business logic: `notification-templates.ts` (6 event types, HTML-escaped email bodies — feedback comments are public unauthenticated input), `NotificationService` (preference/kill-switch/cap checks before enqueueing, one channel's failure never blocks another), 6 trigger points wired into route handlers — always **after** the owning operation's transaction has committed, never from inside a `db.transaction()`-owning service, avoiding a dual-write race between the DB commit and the queue send (mirrors the precedent `qr.routes.ts`'s sentiment-classification enqueue already set) |
| N-4 | 2026-07-10 | API: self-service preference endpoints for both identity systems (no permission gate — same reasoning as a customer managing their own loyalty account; returns a *materialized* eventType x channel grid, not just explicitly-set rows), business-wide settings + send log endpoints (`notifications:view`/`:manage`) |
| N-5 | 2026-07-10 | UI: staff dashboard (`/dashboard/notifications` — preferences grid, business settings, send log, one page/three Cards, no subnav — none of the three views has URL-addressable state worth a dedicated route) and customer screen (`/loyalty/dashboard/[businessId]/notifications`), linked from the account page. New `Switch` design-system primitive (first boolean-toggle need in this app). Found this app has no client-side permission-hiding anywhere (verified by grep, zero matches) — Notifications' settings/log sections follow the same existing convention Analytics already established rather than a one-off fix |
| N-6 | 2026-07-10 | Testing: `notification-templates.test.ts` (rendering + XSS-escaping, all 6 event types), `notification.service.test.ts` (kill switches, SMS cap, opt-out, staff broadcast + permission filter, preference materialization), 2 frontend component test suites (staff + customer preference forms) — scoped to logic-bearing code only, matching this codebase's existing test-coverage convention (presentational primitives, including the new `Switch`, stay untested). Caught one real test-helper bug before it shipped: `makeSettings()` wasn't spreading its `overrides` argument, which would have silently broken the kill-switch and SMS-cap test cases |
| N-7 | 2026-07-10 | Documentation (this update): full endpoint reference for 7 new routes + 2 new permissions in [API.md](./API.md), role-grant table's stale "18 keys" corrected to 20; this file gained Component Responsibilities rows, 3 new Security Architecture rows, 4 new Risks (push not implemented, Resend-vs-native-Email-binding tradeoff, `Queue<PlatformJob>` contravariance never compiler-verified, `feedback_summaries` missing from ERD.md — found, not introduced, see below), the External Services list, and Future Expansion item 6 marked done. [ERD.md](./ERD.md) gained full diagram + field-table entries for all 3 new tables (`notification_preferences`'s two-partial-index design gets the same treatment as `user_business_roles`'). Also caught and fixed two pre-existing drifts this pass found, not introduced: this file's Multi-Tenancy Model section had the permissions-catalog count stale at "16" (never updated to 18 when AI Sentiment Analytics shipped), and ERD.md's `permissions` section had the same count stale at "16 keys / 7 categories" (also missing the Analytics category) — both corrected here. ERD.md itself was never touched during AI Sentiment Analytics' own docs pass (SA-7) despite that module adding `feedback_summaries` — flagged as its own Risks row rather than fixed here, since that table belongs to a different module |
| — | 2026-07-10 | **Notifications complete.** Internationalization & Multi-Currency UI (feature module 6) begins; block numbering resets again below. Full-UI-translation chosen as this module's scope via `AskUserQuestion`, over a narrower "format numbers/dates only" option |
| I18N-1 | 2026-07-10 | Backend settability: `packages/shared-types/src/i18n.ts` (`SUPPORTED_LOCALES` closed enum, `localeSchema`, `resolveSupportedLocale`); new `businesses_default_locale_check` CHECK constraint; `updateBusinessSchema` + `PATCH /businesses/me` (reuses `business:manage_settings`, no new permission); `GET /businesses/:id/public` and `GET /qr/:token` widened with `defaultLocale`/`defaultCurrency`/`defaultTimezone` (free — both handlers already load the full business row) |
| I18N-2 | 2026-07-10 | next-intl infrastructure, "without i18n routing" mode: three-context provider architecture (staff via root `i18n/request.ts` + new `getActiveBusinessQuiet()`; customer via the `[businessId]` layout's own nested provider; anonymous QR via each token page's own provider using the resolve response's `defaultLocale`); `i18n/load-messages.ts`'s per-namespace dynamic-import pattern; `common` namespace seeded |
| I18N-3 | 2026-07-10 | Settings UI (`/dashboard/settings`) + this design system's first Select primitive (`components/ui/select.tsx`, closing a gap open since Branch Mgmt Block 5); `getFormatter()`-based fixes for 6 previously-hardcoded date/currency call sites |
| I18N-4 | 2026-07-10 | Dashboard shell + auth translation (`dashboard`/`auth` namespaces); new `src/test-utils.tsx` `renderWithIntl()` test helper, required the moment a translated Client Component's existing test called bare `render()` |
| I18N-5 | 2026-07-10 | Branch Management + QR Engagement translation (`branches`/`feedback` namespaces); documented, accepted limitation: `feedback/[token]/not-found.tsx` has no locale signal to render in, since the token that led there never resolved |
| I18N-6 | 2026-07-10 | Digital Loyalty translation (`loyalty` namespace, 142 keys, staff + customer). Two self-caught corrections: a Rules-of-Hooks violation from an inline `useTranslations()` call in JSX (fixed by relocating the key to its owning component), and an unrequested pending-state UI change to `delete-tier-button.tsx` reverted as scope creep |
| I18N-7 | 2026-07-10 | AI Sentiment Analytics + Notifications translation (`analytics`/`notifications` namespaces). Removed `lib/notification-preferences.ts`'s static label Records (module-level object literals can't call `useTranslations()`) in favor of direct lookups against one namespace shared by both the staff and customer preference forms. Two self-caught bugs: raw lowercase enum values (`item.sentiment`, `entry.status`) rendering as untranslated badge text in two separate files, both fixed |
| I18N-8 | 2026-07-10 | Testing: new `i18n/resolve-supported-locale.test.ts` + `i18n/load-messages.test.ts` in `apps/web` (covering `packages/shared-types`' `resolveSupportedLocale`, which has no test runner of its own); `renderWithIntl` swapped into 13 existing Client Component test files across 5 modules; 24 message files spot-checked for key-count parity (373 keys each) |
| I18N-9 | 2026-07-10 | Documentation (this update): new `PATCH /businesses/me` endpoint + updated response examples for `GET /businesses/:id/public`/`GET /qr/:token` in [API.md](./API.md); this file gained Component Responsibilities rows, a `next-intl` Dependencies row, 4 new Risks, and Future Expansion item 7 marked done; [ERD.md](./ERD.md)'s `businesses.default_locale` row corrected from "BCP-47 tag" to accurately describe the closed 3-value CHECK constraint |
| — | 2026-07-10 | **Internationalization & Multi-Currency UI complete.** |
| — | 2026-07-11 | Platform Admin Console (feature module 7) begins; block numbering resets again below. Last item on the original Future Expansion roadmap |
| PAC-1 | 2026-07-11 | Schema: `users.platform_role` (nullable, CHECK-constrained `support \| billing \| admin`), layered on top of business-scoped `user_business_roles`, not a replacement; new `requirePlatformRole` middleware re-resolving the role from the DB on every request |
| PAC-2 | 2026-07-11 | Cross-tenant business directory backend: `GET/PATCH /platform/businesses[/:id][/team]`, search + status filter + pagination, status changes admin-only |
| PAC-3 | 2026-07-11 | Cross-tenant audit log backend: `GET /platform/audit-log`, hydrated with business/actor names, filterable, open to every platform role |
| PAC-4 | 2026-07-11 | Impersonation backend: `ImpersonationService` (target-membership validation), `POST /platform/businesses/:id/impersonate`, `signImpersonationToken` (30 min, non-renewable, `impersonatedBy` claim), `support`/`admin` only |
| PAC-5 | 2026-07-11 | Platform admin UI shell: `/platform` route tree, 3-layer gate with an explicit access-denied view, new `GET /auth/me` backing `lib/platform.ts`'s `getCurrentUser()` |
| PAC-6 | 2026-07-11 | Business directory + audit log UI: list/detail/status-form screens, filterable audit log list |
| PAC-7 | 2026-07-11 | Impersonation UI: reason-required confirm dialog, always-visible target-side warning banner backed by a real admin-token-stash exit path (`stopImpersonationAction`) |
| PAC-8 | 2026-07-11 | Billing schema + Stripe backend: `subscription_plans`/`business_subscriptions` tables, card-less 14-day trial auto-provisioning, `billing:view`/`billing:manage` permissions (Owner-only manage), Stripe SDK integration (the one non-`fetch()` third-party call in this codebase), root-mounted signature-verified webhook sync |
| PAC-9 | 2026-07-11 | Business-facing billing UI: `/dashboard/billing` (current-plan card, plan picker, Stripe-hosted Checkout/Portal redirects, Stripe IDs never reach the browser) |
| PAC-10 | 2026-07-11 | Platform-admin billing UI: `/platform/billing` (MRR via real SQL aggregate, paginated subscription list) + `/platform/billing/plans` (plan CRUD); platform DTOs fork rather than widen the business-facing billing contract |
| PAC-11 | 2026-07-11 | Testing: fake-repo unit tests for `SubscriptionProvisioningService`/`BillingService`/`StripeWebhookService`, new `test/integration/billing-permissions.integration.test.ts` against real Postgres |
| PAC-12 | 2026-07-11 | Documentation (this update): full endpoint reference for 17 new routes + 12 new error codes in [API.md](./API.md); `users.platform_role` + `subscription_plans`/`business_subscriptions` added to [ERD.md](./ERD.md); this file gained a Multi-Tenancy Model bullet, Component Responsibilities rows, 4 new Security Architecture rows, a `stripe` Dependencies row, 6 new Risks, and Future Expansion's final item marked done; [SETUP.md](./SETUP.md) gained the 2 new Stripe secrets and plan-catalog seed commands |
| — | 2026-07-11 | **Platform Admin Console complete. Every item on the original Future Expansion roadmap has now shipped.** |
