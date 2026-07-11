# Echo Grid Feedback — Enterprise Customer Experience Platform

QR-driven customer feedback, digital loyalty, and AI-powered sentiment analytics for multi-branch businesses.

## Status

**Multi-Tenant Foundation roadmap complete (Blocks 1-10).** Monorepo, schema,
repositories, auth, RBAC, API layer, audit logging, tests, and docs are all in
place. **Branch Management (feature module 1)**, **QR Engagement (feature
module 2)**, **Digital Loyalty (feature module 3)**, **AI Sentiment
Analytics (feature module 4)**, **Notifications (feature module 5)**,
**Internationalization & Multi-Currency UI (feature module 6)**, and
**Platform Admin Console (feature module 7)** are all complete -- sentiment
classification, async queue-based processing, AI-generated period summaries, a
read-side analytics API, a full dashboard UI (trend chart, AI summaries panel,
searchable feedback explorer), email/SMS delivery for 6 platform events with
self-service preferences, business-wide delivery controls, and a send log,
full UI translation (English/Spanish/French) with locale-aware date/number/
currency formatting across every staff and customer screen, and a
cross-tenant support/billing/admin console (searchable business directory,
platform-wide audit log, time-boxed impersonation, Stripe-backed platform
SaaS billing) layered above the existing business-scoped RBAC without
modifying it. This closes out every item on the original Future Expansion
roadmap. See below, and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for how
all modules are documented alongside the platform foundation.

**Known gaps** (full list with mitigations in
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md#risks--known-gaps)): CORS allows
only `http://localhost:3000` by default (now a config value, `ALLOWED_ORIGINS`
in `wrangler.toml`'s `[vars]`, not a code change — just still unset to any
real deployed origin since nothing is deployed yet); `wrangler.toml` still has
placeholder resource
IDs until provisioned; no code in this project has actually been run yet
(installed, typechecked, or tested) since the environment it was built in had
a persistent sandbox failure across every session this project has been built
in, including this one — **run `pnpm install && pnpm typecheck && pnpm test`
locally before building on top of this.**

## Documentation

| Doc | Covers |
| --- | --- |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System design, request lifecycle, multi-tenancy model, security, scaling, risks, future roadmap |
| [docs/ERD.md](./docs/ERD.md) | Every table, column, constraint, index, and relationship |
| [docs/API.md](./docs/API.md) | Every endpoint, request/response shape, error code, permission requirement |
| [docs/SETUP.md](./docs/SETUP.md) | Provisioning, environment variables, migrations, deployment, troubleshooting |
| [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md) | Ordered, checklist-style runbook from a fresh clone to a live production deploy — Stripe Dashboard setup, go-live checks, rollback |

This README stays a high-level tour with the reasoning behind key decisions;
the documents above are the authoritative reference for each area.

## Stack

| Layer      | Choice                                                          |
| ---------- | ----------------------------------------------------------------- |
| API        | Hono on Cloudflare Workers                                      |
| Frontend   | Next.js (App Router), deployed via OpenNext to Workers          |
| Database   | PostgreSQL on **Neon**, accessed through Cloudflare Hyperdrive  |
| ORM        | Drizzle ORM                                                      |
| Storage    | Cloudflare R2                                                    |
| Cache      | Cloudflare KV                                                    |
| Async jobs | Cloudflare Queues                                                |
| Validation | Zod                                                               |

Chosen to run entirely on Cloudflare's platform (project decision, 2026-07-08). The
database connection string lives in Cloudflare's Hyperdrive configuration, never in
Worker code, `wrangler.toml`, or a secret.

## Structure

```
apps/
  api/              Cloudflare Workers API (Hono)
    src/db/           Drizzle schema (Block 3) + client (Block 4)
    src/repositories/ Tenant-scoped data access, one class per entity (Block 4)
  web/              Next.js frontend (OpenNext → Cloudflare Workers)
packages/
  shared-types/     Public API contract types shared by api + web (from Block 7)
docs/               Architecture, ERD, API contract, setup guide (Block 10)
```

## Quick start

Full walkthrough (Cloudflare provisioning, env vars, troubleshooting) is in
[docs/SETUP.md](./docs/SETUP.md). The short version, once `.dev.vars` and
`.env` are filled in (see that doc):

```bash
pnpm install
pnpm dev:api   # http://localhost:8787/health
pnpm dev:web   # http://localhost:3000
```

## Database schema

Full field-by-field reference, indexes, and relationships:
[docs/ERD.md](./docs/ERD.md). Commands: [docs/SETUP.md#database](./docs/SETUP.md#database).

Tables (`apps/api/src/db/schema/`): `businesses`, `branches`, `users`, `roles`,
`permissions`, `role_permissions`, `user_business_roles`, `audit_log`,
`refresh_tokens`. Notable design choices, in full in code comments:

- Multi-tenancy is shared-schema: every tenant-owned table carries `business_id`.
- `users` is a global identity, not tenant-locked -- `user_business_roles` (not a column
  on `users`) is the source of truth for which businesses/branches/roles a person has,
  business-wide or scoped to one branch.
- `roles` are always owned by one business (no shared/global rows); default roles are
  seeded per business by application logic in Block 6, not hard-coded in the schema.
- `permissions` is a global, platform-defined catalog seeded by migrations as features
  ship, starting in Block 6.
- `audit_log` is append-only and uses `ON DELETE SET NULL` (not cascade) on its business
  and user references, so the trail survives even if either is later purged.

## Repository layer

`apps/api/src/db/client.ts` creates a `pg.Client` + Drizzle instance per request from
the Hyperdrive binding (Cloudflare's documented pattern -- Hyperdrive pools connections
upstream, so a new `Client` per request is cheap). `apps/api/src/repositories/` has one
class per entity -- `BusinessRepository`, `BranchRepository`, `UserRepository`,
`RoleRepository`, `UserBusinessRoleRepository`, `RefreshTokenRepository`,
`PermissionRepository`, `AuditLogRepository` -- each constructor-injected with a
`Database` for easy testing. Two rules hold across all of them: never return
soft-deleted rows by default, and every method on a business-owned entity requires
`businessId` so a lookup can't cross tenant boundaries. `UserRepository` returns full
rows including `passwordHash` -- stripping it before an API response is the caller's
job, not the repository's. `createRepositories(db)` in `repositories/index.ts` builds
all eight at once for route handlers and middleware to share.

## Auth

`POST /auth/signup`, `/login`, `/refresh`, `/logout` (`apps/api/src/auth/`). Passwords
are hashed with PBKDF2-HMAC-SHA256 via Web Crypto (600k iterations, OWASP's 2026
minimum) rather than Argon2id -- every current Argon2 option for Workers is an
unofficial WASM fork requiring manual repackaging, too fragile to depend on for
production password storage; the hash format is self-describing so it can move to
Argon2id later without a mass invalidation. Access tokens are short-lived (15 min)
stateless JWTs; refresh tokens (30 days) are tracked in a `refresh_tokens` table,
hashed at rest, and rotated on every use -- reusing an already-rotated refresh token is
rejected, which catches a stolen token being replayed. `AuthService` is framework-
agnostic (constructor-injected repositories + secrets) so it can be unit tested in
Block 9 without a running Worker.

## RBAC & tenant context

Middleware chain, applied in order (`apps/api/src/middleware/`):
`authenticate` (verifies the access token, sets `userId`) -> `resolveTenantContext`
(reads `X-Business-Id`/`X-Branch-Id` headers, confirms the user is a member, resolves
their effective permission set) -> `requirePermission('key')` (403s if that key isn't
in the set). The header-based tenant lookup is a placeholder Block 7 may replace with a
route param once real business-scoped routes exist -- one line in
`tenant-context.ts` would change.

`POST /businesses` and `GET /businesses/me` were added in this block, ahead of the
original plan: RBAC middleware has nothing to enforce without a real business and a
real role grant to test against, and nothing before this could create either. Creating
a business seeds four starter roles (Owner, Admin, Manager, Staff, each with a
different default permission set -- see `apps/api/src/rbac/role-provisioning.service.ts`)
and grants the creator Owner, all in one transaction.

`GET /businesses` (list, added in Branch Mgmt Block 4) fills a gap the dashboard shell
exposed: nothing let a user discover which businesses they belong to. It dedupes
`user_business_roles` grants by `businessId` (a user can hold separate grants at the
same business across branches) and only requires `authenticate` -- like `POST /`, it's
discovery/bootstrapping, not an action scoped to one already-resolved tenant.

Permission keys follow a `resource:action` convention (`team:invite`, `branches:manage`,
etc.) and live in the `permissions` table, seeded by `pnpm db:seed`
(`apps/api/src/db/seed/permissions.seed.ts`) -- add new keys there as features ship.

## API layer

`/health` is unversioned, at root, outside all middleware -- it's an infrastructure
probe, not API surface. Everything else is mounted under `/api/v1` with a shared
middleware stack (`apps/api/src/index.ts`): request ID, CORS (localhost-only until a
real frontend origin is added), security headers, and a 300 req/min IP-based floor
(`API_RATE_LIMITER`). `/auth/signup` and `/auth/login` additionally carry a stricter
10 req/min limiter (`AUTH_RATE_LIMITER`) -- the brute-force protection flagged as
missing since Block 5.

Both limiters use Cloudflare's native Rate Limiting binding
(`apps/api/src/middleware/rate-limit.ts`), not Durable Objects as originally planned --
Cloudflare ships this as a simpler first-class primitive now, confirmed current as of
this block, so the plan changed to use it.

Every response shares one envelope (`apps/api/src/lib/response.ts` /
`error-handler.ts`): `{ success: true, data }` or `{ success: false, error: { code,
message, details? } }`. Route handlers throw `AppError` (`apps/api/src/lib/errors.ts`)
instead of hand-mapping status codes -- `AuthError` from Block 5 now extends it, so
auth failures flow through the same global handler as everything else. Request body
validation goes through `parseJsonBody()` (`apps/api/src/lib/validate.ts`), which
throws a `400 VALIDATION_ERROR` `AppError` on bad input rather than each route
checking `.safeParse().success` itself.

## Audit logging

Automatic, not opt-in: `apps/api/src/middleware/audit.ts` is mounted globally
(`index.ts`) and records an `audit_log` row for every mutating (`POST`/`PATCH`/`PUT`/
`DELETE`) request under `/api/v1` that completes successfully, with no per-route code
required for baseline coverage. A route can enrich the entry with what specifically
changed by calling `c.set('auditMetadata', {...})` (see `business.routes.ts`'s
`POST /` for an example) -- otherwise a generic `"<METHOD> <path>"` entry is recorded.

Deliberately out of scope: requests with no authenticated actor (`/auth/signup`,
`/auth/login`) aren't captured here -- there's no one to attribute the entry to yet,
and the `users` table's own `createdAt` already records account creation. Failed
requests (4xx/5xx) aren't audited either; the error response is what matters there,
and it's already visible in Workers Logs. A failure while *writing* the audit entry is
caught and logged, never thrown, so it can't turn an already-successful response into
a 500.

`GET /businesses/audit-log` (gated behind the new `audit:view` permission, granted to
Owner/Admin by default) makes the trail readable.

## Testing

Three separate test configs, each with a different scope and cost:

```bash
cd apps/api
pnpm test               # fast, no external deps -- password/JWT/AuthService (fakes)
pnpm test:integration   # needs DATABASE_URL -- real Postgres, skips cleanly without it
pnpm test:workers       # needs wrangler.toml bindings -- runs inside simulated Workers
```

`pnpm test` is the one to run by default and in CI: pure business logic (password
hashing, JWT sign/verify, `AuthService` against small in-memory repository fakes)
using plain Vitest, no database or Workers runtime involved. It covers the properties
that matter most -- refresh-token rotation rejects a replayed old token, logout
revokes, login gives an identical error for a wrong password vs. a nonexistent
account (no user enumeration), signup never stores a raw password.

`pnpm test:integration` runs against a real database instead of mocking
`PermissionRepository.findEffectiveKeys` -- its business-wide-vs-branch-scoped SQL
join is exactly the kind of logic a mock would silently duplicate rather than verify.
Needs migrations applied and `pnpm db:seed` run first; only ever point it at a
scratch/dev database, never production (cleanup soft-deletes, since no repository has
a hard-delete method by design, so repeated runs accumulate rows).

`pnpm test:workers` uses `@cloudflare/vitest-pool-workers` to run the actual exported
`fetch` handler in a simulated Workers runtime -- currently just two smoke tests
(`/health`, and an unauthenticated request getting a 401). This is the config most
likely to need attention before it runs cleanly: `wrangler.toml` still has placeholder
Hyperdrive/KV/R2 IDs until real Cloudflare resources are provisioned.

Not covered yet, deliberately: `AuthorizationService` has no unit test of its own --
it is a thin pass-through to `PermissionRepository`, so a mock-based test would only
verify the mock, not real behavior; the integration suite covers the logic that
actually matters. RBAC middleware (`authenticate`/`resolveTenantContext`/
`requirePermission`) has one smoke test via the Workers pool but no full suite yet --
a reasonable next addition once `test:workers` is confirmed to run cleanly against
provisioned resources.

## Multi-Tenant Foundation roadmap

1. Monorepo scaffold & tooling — **done**
2. Environment & configuration management — **done**
3. Database schema (businesses, branches, users, roles, permissions, audit log) — **done**
4. Database client & repository layer — **done**
5. Auth core (signup, login, JWT access/refresh, PBKDF2 via Web Crypto) — **done**
6. RBAC & tenant-context middleware — **done**
7. API layer skeleton (routing, validation, error handling, rate limiting) — **done**
8. Audit logging — **done**
9. Testing setup — **done**
10. Documentation (architecture, ERD, API contract, setup guide) — **done**

Foundation complete. Next up: the first feature module (see
[docs/ARCHITECTURE.md#future-expansion](./docs/ARCHITECTURE.md#future-expansion)
for the planned order).

## Feature modules

### Branch Management (module 1, complete)

1. Branch Management API — **done**
2. Frontend design system foundation — **done**
3. Auth UI + BFF session handling — **done**
4. Dashboard shell — **done**
5. Branch management screens — **done**
6. Testing — **done**
7. Documentation — **done**

`apps/api/src/branches/` (`branch.routes.ts` + `BranchService`) sits in front of the
`BranchRepository` that already existed from the foundation -- no schema, permission,
or role changes needed, since `branches:view`/`branches:manage` were already seeded.
Every route requires `X-Business-Id`; there's no "bootstrapping" branch action the way
`POST /businesses` is for businesses, so `authenticate` + `resolveTenantContext` are
mounted once for the whole router instead of repeated per route.

Branch request/response schemas live in `packages/shared-types`
(`createBranchSchema`, `updateBranchSchema`, `branchSchema`) -- the first schemas to
land in that package, so the frontend (Block 5) will validate against the exact same
contract as the API rather than a hand-duplicated copy. `business.routes.ts`'s slug
validation was switched to the new shared `slugSchema` while touching this, removing
a small pre-existing duplicate.

`apps/web` now has Tailwind CSS v4 (`apps/web/src/app/globals.css`'s `@theme` block --
original teal/amber palette, no `tailwind.config.js` needed) and five base UI
primitives (`apps/web/src/components/ui/`: Button, Input, Label, Card, Dialog).
Interactive/overlay behavior (Dialog) is built on **Base UI**
(`@base-ui-components/react`), not Radix -- chosen for broader component coverage and
more active maintenance as of mid-2026, at the cost of Base UI still being pre-1.0
(`1.0.0-beta.0`), a real trade-off worth knowing about before relying on it further.
The app never imports `@base-ui-components/react` outside `components/ui/dialog.tsx`,
so swapping libraries later stays contained to that one file.

**Auth is a BFF (Backend-for-Frontend), not a browser-to-API integration.** The
browser never sees an access or refresh token. Login/signup/logout are Next.js
Server Actions (`apps/web/src/lib/actions/auth.ts`) that call the Hono API
server-to-server and write the token pair as httpOnly, `sameSite=lax` cookies
(`apps/web/src/lib/session.ts`) -- not readable by client-side JS, which closes off
the most common XSS token-theft vector. `apps/web/src/lib/api-client.ts`'s
`apiFetch()` is the one place *authenticated* server-side code calls the API from: it
attaches the access-token cookie as a Bearer header and, on a 401, transparently
refreshes once and retries, so a page render never fails just because the 15-minute
access token expired mid-session. `apps/web/src/middleware.ts` gates every route
except `/login`/`/signup` on refresh-token-cookie *presence* only (no network call per
request); `apps/web/src/app/dashboard/layout.tsx` re-checks server-side as
defense-in-depth in case middleware config ever drifts. Because the browser only ever
calls same-origin Server Actions, this sidesteps CORS entirely for the primary web
client -- the API's CORS config (`localhost:3000`-only) stays relevant only for a
hypothetical future direct-browser consumer.

`apps/web/.env.example`'s API URL var was renamed `NEXT_PUBLIC_API_BASE_URL` →
`API_BASE_URL` (dropping the public prefix) as part of this: the browser no longer
needs to know the API's address at all, only the Next.js server does.

The dashboard shell (`apps/web/src/app/dashboard/`) shows a "create your first
business" form when `GET /businesses` returns empty, otherwise the active business's
name/slug with a link into branch management. `apps/web/src/lib/business.ts`'s
`getActiveBusiness()` is the one place that resolves "which business" for every
dashboard page -- extracted in Block 5 so `branches/page.tsx` didn't duplicate
`dashboard/page.tsx`'s original fetch-and-pick-first logic. A business *switcher* is
still deliberately not built: there is no team-invite flow yet, so no user can belong
to more than one business in practice -- the "first business" is unambiguous, not a
placeholder. Revisit with a cookie- or URL-based selector once a future module adds
multi-business membership.

**Branch management screens** (`apps/web/src/app/dashboard/branches/`): a list page
plus one reusable `BranchFormDialog` (Base UI `Dialog`, not a separate route) handling
both create and edit -- passing an existing `branch` prop switches it into edit mode
and binds `updateBranchAction` with `.bind(null, branch.id)` instead of
`createBranchAction`, avoiding a second near-identical form component. All three
mutations (`createBranchAction`, `updateBranchAction`, `deleteBranchAction` in
`apps/web/src/lib/actions/branches.ts`) call `revalidatePath('/dashboard/branches')`
on success so the list reflects changes without a manual refetch. Delete uses a native
`confirm()` rather than a custom dialog -- a deliberately minimal choice, worth
upgrading to a shared confirm dialog if a future block wants more polish or a
typed-confirmation step for higher-stakes deletes.

Deliberately left out of the create/edit form: latitude/longitude (the schema and API
already support them; a bare numeric input is poor UX for picking a location and isn't
worth shipping ahead of a real "set on map" control). Country code and timezone are
plain text inputs, not dropdowns -- the design system has no Select/Combobox primitive
yet (only Button, Input, Label, Card, Dialog exist), and building one (searchable,
~250 countries / ~400 IANA timezones) is a real scope addition beyond this block; a
good candidate for its own small block later. Permission-aware UI (hiding
Edit/Delete/+New for users without `branches:manage`) also isn't wired up -- every
user today is necessarily their business's Owner (the only way to gain membership is
creating the business), so no lower-privileged user can reach this screen yet; revisit
once a team-management module introduces invites and non-Owner roles.

Two bugs caught by reading the actual code instead of assuming its shape, before they
shipped: `DELETE /branches/:id` returns a bare `204` with no JSON body (`branch.routes.ts`),
which `apiFetch`'s envelope parser would have misread as a failure (`response.json()`
throwing, then `!body?.success` reading `null` as unsuccessful) -- fixed with an
explicit 204 short-circuit in `lib/api-client.ts`. And Base UI's `Dialog.Trigger`/
`Dialog.Close` use a `render` prop (not Radix's `asChild`), confirmed via live search
rather than assumed from the Radix-shaped mental model most headless-UI libraries
share -- passing a `<Button>` as plain children would have nested a real `<button>`
inside it.

#### Testing (Block 6)

**Backend** extends the Foundation's existing three-tier split (see "Testing" above)
rather than introducing a new pattern: `apps/api/src/branches/branch.service.test.ts`
(fakes, `pnpm test`) covers slug uniqueness being scoped per-business (not global), 404
winning over 409 when both would apply on update, and that every lookup is
tenant-isolated -- the same properties AuthService's tests protect for auth.
`BranchRepository`'s queries are simple single-table filters (no joins), so unlike
`PermissionRepository.findEffectiveKeys` they don't need their own integration test --
except for one thing a fake can never verify: whether the `businessId+slug` UNIQUE INDEX
actually exists and is enforced by Postgres itself. That's covered by a new
`test/integration/branch-slug-uniqueness.integration.test.ts`. `test/workers/health.test.ts`
gained one more smoke test proving `/branches` is actually mounted (a 401, not a 404,
proves the router wiring in `index.ts`, not just that `authenticate()` works in the
abstract).

**Frontend** had zero test infrastructure before this block. Two tiers, chosen to mirror
the backend's cost/value split: Vitest + React Testing Library (`apps/web/vitest.config.ts`,
`pnpm test`) for fast component/logic tests, and Playwright (`apps/web/playwright.config.ts`,
`pnpm test:e2e`) for real end-to-end flows. This split isn't arbitrary -- Vitest/RTL
cannot render this app's Server Components at all (every `page.tsx`/`layout.tsx` here is
an async function, and async Server Component rendering isn't supported by React Testing
Library, confirmed current via live search), so component tests are scoped to Client
Components and pure functions only (`BranchFormDialog`, `DeleteBranchButton`, `LoginPage`,
`readBranchForm`), with Server Actions mocked at the module boundary rather than actually
invoked. Playwright is the only tier that exercises real signup, real httpOnly cookies,
and a real Server Component fetch through the BFF -- one critical-path smoke test
(`e2e/branch-management.spec.ts`: signup → create business → create branch → see it
listed) is the skeleton for this tier, not exhaustive coverage, and -- like
`test:workers` -- is the least likely tier to run cleanly without a real database
already migrated and seeded.

`lib/actions/branches.ts`'s `readBranchForm` helper was extracted into its own
`lib/branch-form.ts` while writing its test: a `'use server'` file's exports must ALL be
async functions (Next.js's own build-time constraint on Server Action modules), and this
was a synchronous pure function that could never have been exported for testing without
either breaking that rule or forcing it async for no reason. The extraction is a real
separation-of-concerns improvement independent of testing, not just a workaround.

Writing the E2E test also surfaced a real accessibility bug in Block 5's dashboard:
`dashboard/page.tsx`'s "View branches" control nested a `<Button>` (a real `<button>`)
inside a `<Link>` (a real `<a>`) -- invalid HTML that breaks accessible-name computation,
the same class of bug already caught and fixed for Base UI's `DialogTrigger` earlier in
this block. Fixed by exporting `buttonVariants` from `button.tsx` so a plain `<Link>` can
be styled identically to a button without nesting one inside the other.

#### Documentation (Block 7)

[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) formally gained `apps/web`'s architecture
-- until this block it only ever documented `apps/api`, since no frontend code existed
when it was written (Foundation Block 10). New "Layered Architecture (apps/web)" section
covers the Server Component / Server Action / `apiFetch()` / session layering and writes
up the BFF auth pattern in full (previously only explained here in the README); the
Security Architecture, Component Responsibilities, and Dependencies tables all gained
`apps/web` rows/sections; Risks & Known Gaps picked up the frontend-specific gaps called
out per-block above (no Select primitive, no business switcher, unverified E2E suite,
unconfirmed dependency versions); Future Expansion's "Branch management UI" item is
marked done instead of removed, so the historical roadmap stays legible.

[docs/API.md](./docs/API.md) gained full reference docs for all 5 branch endpoints and
the `GET /businesses` list endpoint (added back in Block 4, never documented until now --
a real gap, not new work invented for this block), plus the `BRANCH_NOT_FOUND` error
code. "Not Yet Implemented" no longer lists branch CRUD.

[docs/SETUP.md](./docs/SETUP.md) corrected the `apps/web/.env.local` example (it still
said `NEXT_PUBLIC_API_BASE_URL`, stale since Block 4's rename) and gained frontend test
commands (`pnpm test`, `pnpm test:e2e`) alongside the existing backend ones.
[docs/ERD.md](./docs/ERD.md) needed no changes -- Branch Management added no tables or
columns; `branches` was already fully modeled and documented by the Foundation.

---

**Branch Management module complete.** Across 7 blocks: a full branch CRUD API reusing
the Foundation's existing schema and RBAC; `apps/web`'s first-ever screens, and with them
its entire frontend foundation (Tailwind v4 design system, Base UI primitives, BFF auth,
Server Actions as the one mutation path); two test tiers where zero existed before; and
documentation brought back into sync across all four `docs/` files plus this README.

### QR Engagement (module 2, in progress)

1. Schema (`qr_codes` + `feedback` tables, repositories, permissions) — **done**
2. Backend API (public + authenticated routes) — **done**
3. Public feedback landing page — **done**
4. QR code display + management UI — **done**
5. Feedback inbox UI — **done**
6. Testing — **done**
7. Documentation — **done**

Scope for this module was a deliberate merge of two originally-separate items on the
Future Expansion roadmap ("QR generation" and "Feedback & reviews") -- a QR code that
lands on a placeholder page delivers no real value, so the module now covers QR
generation *and* the full capture-and-view loop end to end. Full reasoning in
[docs/ARCHITECTURE.md#future-expansion](./docs/ARCHITECTURE.md#future-expansion).

New tables (`apps/api/src/db/schema/{qr-codes,feedback}.ts`): `qr_codes` holds an opaque
public `token` (deliberately separate from the row's own `id` -- shorter payloads scan
more reliably, and regenerating never touches the branch's real id or its FK
references), with a partial unique index enforcing at most one *active* code per branch
at the database level, the same pattern `user_business_roles`' partial indexes already
use. `feedback` captures anonymous customer submissions -- `createdBy` stays NULL for
every row, the same way `audit_log` already handles "no authenticated actor" for
signup/login. Both tables cascade on delete like everything else in this schema
(deliberately **not** `audit_log`'s `SET NULL` pattern -- feedback is normal tenant data,
not a compliance trail, and an orphaned businessId would break the "every lookup requires
businessId" tenant-isolation convention every other repository relies on).

Two new permissions, `feedback:view`/`feedback:manage`, seeded and granted to default
roles: Owner/Admin/Manager get both, Staff gets view-only (seeing feedback about their
own branch is reasonable day-to-day context; triaging it reads as a supervisory action,
consistent with Staff being view-only everywhere else in the permission table).

**Real architecture change from the original plan, decided before writing any code:**
no server-side QR image generation, and R2 isn't used for it despite SETUP.md's original
note that R2 exists partly for "QR images." A QR code is just a token + a known URL --
rendering the actual scannable image is a solved, cheap client-side problem (Block 4),
with no Workers-runtime compatibility risk and no storage lifecycle to manage. R2 stays
reserved for what it's actually suited for.

Migration not yet generated/applied -- `pnpm db:generate && pnpm db:migrate` in
`apps/api` is the next step before any of this schema exists in a real database.

**Block 2 -- Backend API.** Two new route files plus one extension:

- `apps/api/src/qr/qr.routes.ts` (new) -- fully public, no `authenticate` anywhere in
  the file. `GET /api/v1/qr/:token` resolves a token to `{branchId, branchName,
  businessName}` for the landing page; `POST /api/v1/qr/:token/feedback` is the
  submission endpoint. Both sit behind a new `PUBLIC_RATE_LIMITER` binding (20/min/IP,
  an uncalibrated starting estimate) stacked on top of the existing global
  `API_RATE_LIMITER`, the same layering `AUTH_RATE_LIMITER` uses on `/auth/*`. This is
  the platform's only anonymous write surface, reached exclusively through `apps/web`
  Server Actions, never called directly from a browser -- the BFF pattern from Branch
  Management Block 3 applies here too, not just to authenticated traffic.
- `apps/api/src/feedback/feedback.routes.ts` (new) -- authenticated inbox:
  `GET /api/v1/feedback` (list, `feedback:view`), `PATCH /api/v1/feedback/:id`
  (mark reviewed, `feedback:manage`, deliberately narrow --
  `{status: 'reviewed'}` only, a business can never edit a customer's actual
  rating/comment), `DELETE /api/v1/feedback/:id` (soft-delete, `feedback:manage`).
- `branch.routes.ts` extended with `GET /api/v1/branches/:id/qr-code`
  (`branches:view`, lazy get-or-create -- a branch's QR code is created on first
  request rather than at branch-creation time, keeping `BranchService` untouched) and
  `POST /api/v1/branches/:id/qr-code/regenerate` (`branches:manage`, revokes the old
  code and issues a new one). Nested under `/branches` rather than living in
  `qr.routes.ts` because route ownership follows URL structure; response is
  `{id, token, status}` only -- no full scannable URL, since building
  `https://{domain}/feedback/{token}` needs the frontend's own base URL, which the API
  has no reason to know.

`QrCodeService`/`FeedbackService` (new, one per domain folder) hold this logic.
Token generation uses `crypto.randomUUID()` (hyphens stripped, truncated to 20 hex
chars, ~80 bits of entropy) rather than a `btoa`-based encoding of raw random bytes --
`randomUUID` is a Cloudflare-documented Workers API with no runtime-compatibility
uncertainty, consistent with this project's established preference (PBKDF2 over
Argon2 in Foundation auth) for native Web Crypto over anything with unverified Workers
support.

`packages/shared-types` gained `qr-codes.ts` and `feedback.ts`: `submitFeedbackSchema`
(rating required 1-5, every contact field optional -- a contact-info wall in front of
a star rating would defeat the point of a frictionless QR flow), `updateFeedbackStatusSchema`,
`feedbackSchema`, `qrCodeSchema`, `qrResolveSchema`.

`wrangler.toml`'s `UPLOADS` R2 binding comment was also corrected in this block (was
still claiming "QR images" among its uses) rather than deferred to Block 7 -- it's a
one-line fix directly caused by this block's own no-server-side-QR-image decision, in
the same file already being edited to add `PUBLIC_RATE_LIMITER`.

**Block 3 -- Public feedback landing page.** The customer-facing side of the module,
`apps/web/src/app/feedback/[token]/`:

- `page.tsx` (Server Component) resolves the token server-side via a new
  `publicApiFetch()` helper (`lib/public-api-client.ts`) -- the anonymous counterpart
  to the existing `apiFetch()`, deliberately separate rather than an "anonymous mode"
  flag on it, since none of `apiFetch`'s cookie/Bearer/401-refresh machinery applies to
  a route that never has a session. Both share the same envelope-parsing logic
  (`parseEnvelope`, now exported from `lib/api-client.ts` instead of staying private)
  so this isn't a second near-duplicate copy of that parsing. An unknown/revoked token
  calls Next's `notFound()`, rendering a custom `not-found.tsx` for this route segment
  -- deliberately not the framework's generic 404, since a broken-looking error page is
  the worst possible first impression for a customer who just scanned a real QR code.
- `feedback-form.tsx` (Client Component) is the interactive form: star rating,
  optional comment, and an optional contact-info section inside a native `<details>`
  disclosure (collapsed by default, no extra toggle state needed). Submits through a
  new `submitFeedbackAction` Server Action (`lib/actions/qr-feedback.ts`), bound to the
  scanned token with `.bind(null, token)` -- the same pattern `updateBranchAction`
  already uses for branchId. On success, swaps in a "Thank you!" confirmation in place
  of the form rather than redirecting, avoiding both a second round trip and a URL
  flash.

Two new reusable design-system primitives (`components/ui/`): `Textarea` (mirrors
`Input`'s conventions exactly) and `StarRating`. The rating control is built on 5 real
`<input type="radio">` elements sharing one `name`, visually hidden (`sr-only`, not
`display:none`, so they stay in the accessibility tree) and paired with a decorative
SVG star whose fill follows React state -- chosen over a hand-rolled keyboard-driven
widget because a native radio group already provides arrow-key navigation and
screen-reader "N of 5" semantics for free, and marking the first radio `required` makes
the browser enforce "at least one selected" with no custom validation code. The value
flows through the surrounding `<form action={formAction}>` via ordinary FormData, the
same mutation path every other form in this app uses.

`lib/feedback-form.ts`'s `readFeedbackForm` mirrors `lib/branch-form.ts`'s
`readBranchForm` pattern exactly -- a plain (non `'use server'`) FormData-parsing
function, directly unit-testable, deferring actual validation to the shared
`submitFeedbackSchema` enforced server-side.

**Block 4 -- QR code display + management UI.** The dashboard-side counterpart to
Block 3, added to the existing branches list rather than a new page/route: a
"QR code" button on each branch card (next to Edit/Delete) opens `QrCodeDialog`
(`app/dashboard/branches/qr-code-dialog.tsx`) -- reusing the same Dialog-from-a-list-row
interaction pattern `BranchFormDialog` already established, instead of introducing a
new navigation paradigm for something this comparably lightweight.

The dialog fetches on open rather than receiving QR data as a server-rendered prop --
`GET /branches/:id/qr-code` lazily *creates* a code on first call (Block 2's design),
so fetching eagerly for every branch when the list loads would silently auto-create a
code for branches nobody asked about yet. Two new fetch-oriented Server Actions
(`lib/actions/qr-codes.ts`, `getQrCodeAction`/`regenerateQrCodeAction`) are called
imperatively from the dialog's `useEffect`/button handlers rather than through
`useActionState`/`<form action>` -- Server Actions support this directly, and it keeps
the "browser never calls the Hono API directly" BFF invariant intact even for this
on-demand fetch.

QR rendering uses **react-qr-code** (SVG-only, ~92 kB unpacked, live-searched against
`qrcode.react` and `qr-code-styling` before adding it) -- SVG over canvas/PNG because
these codes are meant to be printed and displayed at a physical branch, where
vector output stays crisp at any size; `qr-code-styling`'s logo/gradient/branding
features were ruled out as unneeded complexity for what is fundamentally a functional
dashboard utility, not a marketing surface. "Download SVG" serializes the rendered
`<svg>` node directly (`XMLSerializer`) rather than converting to PNG/canvas, matching
the print use case and avoiding an extra rendering step.

The scannable URL (`{origin}/feedback/{token}`) is built from `window.location.origin`
at render time, not a new env var -- the dashboard and the public landing page (Block 3)
are the same Next.js deployment, so wherever the dashboard is being served from is, by
definition, the correct host for the customer-facing URL too. Regenerate reuses
`DeleteBranchButton`'s established `confirm()`-then-`startTransition` pattern (a
regenerate revokes the current code immediately -- any printed copies stop working,
comparably consequential to a delete).

**Block 5 -- Feedback inbox UI.** New `/dashboard/feedback` page (added to
`dashboard-nav.tsx`) -- closes the loop: Blocks 1-4 built the full submission pipeline,
but until now nothing let a business actually *see* what customers submitted.

Three new design-system primitives, extracted for genuine reuse rather than
duplicated: `StarIcon` (the raw SVG glyph, pulled out of Block 3's `StarRating` so
Block 5's new read-only `StarDisplay` reuses the same icon markup instead of a second
copy of the path data), `StarDisplay` (5 `StarIcon`s, no state/hooks -- a submitted
rating is not a form interaction, so it deliberately does not reuse `StarRating`'s
radio-input structure), and `Badge` (a generic status pill, variant-named by semantic
color rather than by feedback's own vocabulary, so it's reusable for future modules --
loyalty tiers, business status -- not feedback-specific).

Branch filtering uses a plain native `<select>` (`branch-filter.tsx`), not a custom
Combobox -- no Select/Combobox primitive exists yet in this design system (flagged as
deferred scope since Branch Mgmt Block 5), and a native select is fully accessible
without waiting on one. The URL's `?branchId=` is the source of truth, not client
state, keeping the list itself a plain Server Component fetch (shareable/bookmarkable
filtered views, consistent with this app's Server-Component-first bias).

Pagination is "Newer/Older" offset links (`?offset=`), not numbered pages --
`FeedbackRepository.listForBusiness` has no total-count query, so true page-N-of-M
pagination isn't available without a backend change out of scope here. Fetches
`PAGE_SIZE+1` (21) items and checks whether the extra one came back, the standard
no-count-needed way to know an "Older" link should exist.

Mark-reviewed and Delete (`feedback-actions.tsx`, `lib/actions/feedback.ts`) mirror
`DeleteBranchButton`'s pattern, with one deliberate difference: only Delete gets a
`confirm()` gate. Marking reviewed is a one-way transition (the API only ever accepts
`{status:'reviewed'}`, no route back to `'new'`) but is low-stakes enough not to need
confirmation -- no data loss, and the feedback content stays fully visible either way,
just visually deprioritized.

**Known gap flagged, not fixed, in this block:** this page runs its two reads
(`/branches`, `/feedback`) via `Promise.all` for the real performance win of doing
independent fetches in parallel -- but this is also the first place in `apps/web` that
calls `apiFetch` twice concurrently. `apiFetch`'s 401-refresh logic has no
request-deduplication: if the access token happens to be expired at the exact moment
both calls fire, each could independently attempt `/auth/refresh`, and since refresh
tokens rotate on use, the losing request could get rejected on an already-rotated
token. This is a pre-existing characteristic of `api-client.ts`'s design, not something
new introduced here, and the correct fix (a single-flight refresh lock) belongs in that
shared file, not worked around per-page. Low real-world impact (surfaces as one failed
fetch, recoverable by reload, not silent data corruption) -- flagged for a future
hardening pass rather than scope-creeping into `api-client.ts` during a UI block.

**Block 6 -- Testing.** Extends both of Branch Mgmt Block 6's established tiers rather
than inventing new ones.

Backend: `qr-code.service.test.ts` and `feedback.service.test.ts` (fakes, mirror
`branch.service.test.ts`'s exact style) cover the lazy get-or-create/regenerate
lifecycle, the identical-404-for-unknown-and-revoked-token enumeration resistance, and
404-before-mutation ordering on `markReviewed`/`remove`. New
`test/integration/qr-code-active-uniqueness.integration.test.ts` covers the one thing a
fake can never verify -- whether the partial unique index
(`qr_codes_branch_type_active_key`) actually exists and is enforced by Postgres, same
reasoning as Branch Mgmt Block 6's slug-uniqueness test. `test/workers/health.test.ts`
gained two more smoke tests: `GET /api/v1/qr/:token` proving the route is genuinely
public (an unknown token 404s, not 401s -- flagged as NOT expected to pass pre-real-
Hyperdrive, unlike the other smoke tests, since this route has no early-return
middleware to short-circuit before it queries), and `GET /api/v1/feedback` proving the
authenticated route is mounted and gated.

Frontend: `lib/feedback-form.test.ts` mirrors `branch-form.test.ts`'s exact pattern for
`readFeedbackForm` (including the real quirk that `Number(null)` is `0`, not `NaN` --
verified against the actual implementation before asserting it, not assumed).
`components/ui/star-rating.test.tsx` covers click-to-select, the single-required-radio
HTML5-validation trick, and that the selected value round-trips through native
FormData. `feedback-actions.test.tsx` mirrors `delete-branch-button.test.tsx` exactly
for Delete, plus covers Mark Reviewed's deliberately confirm()-free path.
**Deliberately NOT unit-tested:** `QrCodeDialog` -- its fetch-on-open + SVG-blob-download
behavior needs `URL.createObjectURL`/`XMLSerializer`, both awkward to reliably exercise
in jsdom for real added value; its core behavior (rendering, fetching, regenerate) is
still covered by the new E2E test below, matching how `AuthorizationService` was
deliberately left without a unit test back in Foundation Block 9.

New `e2e/qr-engagement.spec.ts`: one critical-path test covering the full loop
Vitest/jsdom structurally cannot reach -- signup, create a branch, read its QR token
directly off the dashboard (no real scanner needed), submit feedback from a SEPARATE,
unauthenticated browser context (a real customer never shares the owner's session),
and confirm it appears back in the authenticated inbox. Deliberately one test, not a
suite, same skeleton framing as `branch-management.spec.ts` -- flagged as the least
likely tier to run cleanly (needs both dev servers plus a real migrated+seeded
database), unverified this session (sandbox down the entire session, same as every
prior block).

**Block 7 -- Documentation.** Final block of QR Engagement -- module now complete
(all 7/7 blocks).

[docs/API.md](./docs/API.md) gained full reference for all 7 new endpoints (`GET
/qr/:token`, `POST /qr/:token/feedback`, `GET/POST /branches/:id/qr-code[/regenerate]`,
`GET/PATCH/DELETE /feedback`), 2 new error codes (`QR_CODE_NOT_FOUND`,
`FEEDBACK_NOT_FOUND`), 2 new permissions, and the public-route rate limit note. The
"Not Yet Implemented" section's QR/feedback line was removed (verified false) and
replaced with a pointer to where those endpoints now live.

[docs/ERD.md](./docs/ERD.md) gained full field references for `qr_codes` and
`feedback` -- unlike Branch Management Block 7 (which needed no ERD changes, since that
module added zero tables), this module added two, so this update was a real content
addition, not a "confirmed no changes needed" check.

[docs/SETUP.md](./docs/SETUP.md) gained the third `[[ratelimits]]` block in its
provisioning table, a note that the QR feedback URL is built from
`window.location.origin` rather than a new env var, and a fix to the `UPLOADS` R2
bucket's provisioning comment (still said "QR images" -- the actual fix landed in
`wrangler.toml` itself back in Block 2, but this doc's copy of that comment was never
updated to match, the same class of doc/code drift Branch Mgmt Block 7 caught with
`NEXT_PUBLIC_API_BASE_URL`).

[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) gained `src/qr/`/`src/feedback/` and the
new `apps/web` files in Component Responsibilities, the public rate limiter in Security
Architecture, `react-qr-code` in Dependencies, two new Risks (the `apiFetch`
concurrent-401-refresh gap flagged in Block 5, and the `GET /qr/:token` smoke test's
real-Hyperdrive dependency), and a full QR-1 through QR-7 Changelog section. Future
Expansion items 2 ("QR engagement module") and 3 ("Feedback & reviews") are marked done
via strikethrough, with a note that they were deliberately merged into one module rather
than shipped separately -- matching how Branch Management's own Future Expansion item
was marked done in its Block 7.

---

**QR Engagement module complete.** Across 7 blocks: the full scan-to-inbox loop end to
end -- schema, a genuinely public API surface (the platform's first, with its own rate
limiter and enumeration-resistant token resolution), a customer-facing landing page, a
dashboard-side QR management dialog, a feedback inbox, two test tiers extended to cover
all of it, and documentation brought back into sync across all four `docs/` files plus
this README. One real architecture deviation from the original roadmap, decided
deliberately and flagged throughout: no server-side QR image generation or R2 storage --
a QR code is a token + URL, rendered client-side. One known gap surfaced and intentionally
left open rather than scope-crept into a fix: `apiFetch`'s lack of concurrent-401-refresh
deduplication, first exposed by this module's own `Promise.all` usage.

### Digital Loyalty (module 3, complete)

1. Schema (`customers`, `otp_codes`, `loyalty_accounts`/`tiers`/`rewards`/`transactions`) — **done**
2. Customer identity & OTP verification (backend) — **done**
3. Loyalty accounts & points engine (backend) — **done**
4. Rewards & redemption (backend) — **done**
5. Customer-facing loyalty UI — **done**
6. Staff-facing loyalty management UI — **done**
7. Testing — **done**
8. Documentation — **done**

The platform's most architecturally significant module so far: it introduces a
**second, parallel identity system**. Customers have no staff-style login, dashboard
access, or RBAC -- identity is established via SMS OTP instead of email+password. Faced
with the question "how does a returning customer's loyalty identity work with no
platform login," the recommended default (no verification at all, fastest to ship) was
presented alongside SMS OTP and email magic-link via `AskUserQuestion` -- the user chose
SMS OTP, which drove the entire Block 1/2 design: an OTP subsystem, a Twilio integration,
and a dedicated customer JWT system.

**Block 1 -- Schema.** `customers` (new tables `apps/api/src/db/schema/`) is deliberately
modeled after the existing `users`/`user_business_roles` split rather than inventing a
new pattern: `customers` is a **global** identity (one row per phone number, platform-
wide, mirroring how `users` is global), and `loyalty_accounts` is the **business-scoped**
membership (one row per customer-per-business, mirroring `user_business_roles`). A
customer scanning a QR code at a second, unrelated business never re-verifies their
phone. `otp_codes` has no FK to `customers.id` -- a phone's first-ever OTP request
happens before any customer row exists. `loyalty_transactions` is an append-only ledger
(mirrors `audit_log`) behind `loyalty_accounts.points`'s denormalized running total, with
one deliberate, narrow exception to append-only: `redemption_confirmed_at` is a single
one-way `UPDATE` when staff confirms a redemption, mirroring `feedback.status`'s
`new`→`reviewed` transition. `loyalty_transactions.type` gets a CHECK constraint (unlike
`qr_codes.type`) because every earning/spending mechanism is fully designed now, not
speculative. Three new permissions (`loyalty:view`, `loyalty:manage`, `rewards:manage`) --
Staff gets `loyalty:manage` (recording a purchase or confirming a redemption is a
front-counter task) but not `rewards:manage` (editing a reward's point cost is a real
fraud vector if left open to front-line staff, so that one stays Manager+ only, the one
place Loyalty's default grants diverge from Feedback's Staff-is-view-only precedent).

**Block 2 -- Customer identity & OTP verification.** `src/auth/password.ts`'s PBKDF2
logic was refactored (backward-compatibly) into generic `pbkdf2Hash`/`pbkdf2Verify`
primitives so a new `src/customer-auth/otp.ts` could reuse the exact same self-describing
hash format at a **far lower iteration count** (10k vs. passwords' 600k) -- an OTP's
security comes from a 10-minute expiry and a 5-attempt cap, not offline-hash resistance,
so paying the password-grade cost on every SMS code check would only add latency for no
real protection. SMS delivery (`src/customer-auth/sms.service.ts`) calls Twilio's REST
API via plain `fetch()`, not the official Node SDK, whose Workers-runtime compatibility
is unverified -- consistent with this project's established PBKDF2-over-Argon2 reasoning
(native/simple over SDK-with-unverified-Workers-support). A `ConsoleSmsService` fallback
logs the code instead of sending it whenever `ENVIRONMENT !== 'production'`, so local dev
never spends real Twilio credit. Customer sessions are a single, non-rotating 90-day JWT
(`customer-jwt.ts`, `CUSTOMER_JWT_SECRET` -- a fully separate secret from staff's) rather
than the full access+refresh+rotation system staff gets -- a deliberate scope reduction
justified by much lower stakes (view/redeem own points only, no privilege-escalation
surface). New `customerAuthenticate` middleware mirrors `authenticate.ts` but sets
`customerId` on context instead of `userId`, and checks the token's `type` claim
(`'customer_access'`) as defense in depth on top of the separate secret. `POST
/customer-auth/otp/request` and `/verify` are fully public routes, guarded by a new,
deliberately strict `OTP_RATE_LIMITER` (3/min/IP -- each request costs real SMS money,
unlike a free feedback submission).

**Block 3 -- Loyalty accounts & points engine.** `LoyaltyAccountService`
(`src/loyalty/loyalty-account.service.ts`) is the platform's third service (after
`BusinessService`) to own a `db.transaction()` directly rather than take injected
repositories -- every earning method needs a transaction spanning the balance update, a
tier recalculation, and the ledger insert. `recordCheckin` auto-enrolls a customer on
their first scan at a business (no separate "join" step required); `recordPurchase`
computes points from a business's configurable `pointsPerCurrencyUnit` rate, floored in
the business's favor; `adjustPoints` is a manual staff correction, pre-checked against
going below zero (a clear `422`) rather than relying on the database's `CHECK
(points >= 0)` constraint to reject the whole transaction. A new `loyalty_settings` table
(one row per business, lazily created with defaults) was added in *this* block, not
Block 1's schema pass -- it only became clear the points engine needed configurable
earning rates once actually writing the earning logic, and hard-coding "10 points per
check-in" would have violated this project's own "never hard-code limits" standing rule
the moment two businesses want different rates.

**Block 4 -- Rewards & redemption.** Two-phase by design: `LoyaltyRedemptionService.redeem`
never hands over the actual reward, it only reserves the points and issues an 8-character
human-typeable code (`redemption-code.ts` -- alphabet excludes visually ambiguous
characters `0/O/1/I/L`, distinct from OTP's numeric-only alphabet since this one is read
off a screen and typed into a staff dashboard, not a phone keypad); `confirmRedemption` is
the separate staff action confirming the physical handoff actually happened, one-way (a
second confirm attempt on the same code is rejected). `LoyaltyTierService`/
`LoyaltyRewardService` are thin, repository-injected config CRUD (rewards:manage) --
unlike the two transaction-owning services above, these mirror `FeedbackService`'s simple
shape and are fully unit-testable with fakes.

**Block 5 -- Customer-facing UI** (`apps/web/src/app/loyalty/`). A new, entirely separate
session domain: `lib/customer-session.ts`/`customer-cookies.ts` (a distinct
`ff_customer_token` cookie, never merged with staff's `session.ts`) and
`lib/customer-api-client.ts` (`customerApiFetch()`, no 401-refresh logic since there's
nothing to refresh). Two-step SMS sign-in (`/loyalty/login`) mirrors `/login`'s shape but
splits into `requestOtpAction`/`verifyOtpAction`. The QR check-in landing page
(`/loyalty/[token]`) reuses the exact same anonymous token `/feedback/[token]` resolves --
one QR code, two possible customer-facing destinations. The loyalty dashboard
(`/loyalty/dashboard/[businessId]`) shows tier progress via a new `Progress` design-system
primitive, the active reward catalog, and a redeem-and-show-code flow. **Found and fixed a
real pre-existing bug while wiring `/loyalty` into `middleware.ts`:** `/feedback` was never
in `PUBLIC_PATHS`, meaning every anonymous customer scanning a QR code for *feedback* was
being redirected to the staff `/login` page the entire time QR Engagement has existed --
unnoticed because the E2E suite exercises pages directly, not through this middleware. Both
`/feedback` and `/loyalty` are now correctly exempted from the staff-session gate, and the
"redirect an already-logged-in user away from an auth page" check was narrowed to actual
auth pages (`/login`, `/signup`) so a signed-in staff member can still view a public page
without being bounced to `/dashboard`.

**Block 6 -- Staff-facing UI** (`apps/web/src/app/dashboard/loyalty/`). Accounts list
(joined with customer phone/name via an extended `LoyaltyAccountRepository.listForBusiness`
-- the DTO alone is just a UUID, unusable for a human-facing staff screen) with a
purchase/adjust management dialog; tiers/rewards CRUD screens reusing `BranchFormDialog`'s
exact controlled-dialog pattern; a settings form for earning rates; a redemption-confirmation
counter tool (look up a code, see what it's for, confirm the handoff -- deliberately two
separate steps, not one blind-confirm button). Two small backend additions shipped
alongside the UI rather than deferred, consistent with this project's preference for full
vertical slices over backend-only blocks: a public `GET /businesses/:id/public` endpoint
(name-only, anonymous -- customer pages need a business name with no staff session) and a
customer-facing `GET /loyalty/me/tiers/:businessId` (the tier ladder, not just the
account's current tier, needed for the progress bar).

**Block 7 -- Testing.** Every repo-injected service (`CustomerAuthService`,
`LoyaltyTierService`, `LoyaltyRewardService`) gets fake-repo unit tests mirroring
`branch.service.test.ts`'s exact style, plus pure-logic tests for the OTP/redemption-code
primitives and the customer JWT. The two transaction-owning services
(`LoyaltyAccountService`, `LoyaltyRedemptionService`) get **integration** tests instead --
a fake `Database.transaction()` can't meaningfully verify atomic delta application + tier
recalculation + an append-only ledger, so `test/integration/loyalty-points-engine` and
`loyalty-redemption` run against real Postgres, same reasoning `PermissionRepository`'s
join-heavy logic already established. `test/workers/loyalty.test.ts` proves both auth
gates are independent and correctly separated (a garbage staff-shaped bearer token still
401s against the customer-gated routes, and vice versa). **Deliberately incomplete, and
said so rather than silently skipped:** `e2e/loyalty.spec.ts` covers only the staff-side
setup flow (tiers/rewards/settings) -- `ConsoleSmsService` logs the OTP code to the API
dev server's stdout in non-production, and Playwright's `webServer` config has no
reliable way to read that log back out mid-test, so the customer-facing check-in/redeem
flow has no E2E coverage yet. Flagged in ARCHITECTURE.md's Risks as a real gap with a
concrete recommended fix (a dev-only "last code for this phone" backdoor endpoint), not
swept under the rug.

**Block 8 -- Documentation.** [docs/API.md](./docs/API.md) gained full reference for 19
new endpoints (customer-auth's 2 public OTP routes, the public business-name lookup, 11
staff-facing loyalty routes, 6 customer-facing `/loyalty/me/*` routes), 11 new error
codes, and 3 new permissions with the Staff-diverges-from-Feedback reasoning spelled out.
[docs/ERD.md](./docs/ERD.md) gained full field references for all 7 new tables.
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) gained a new Multi-Tenancy Model bullet
explaining the dual-identity design, new Component Responsibilities rows for
`src/customer-auth/`/`src/loyalty/` and their `apps/web` counterparts, new Security
Architecture rows (customer auth, OTP abuse controls), an expanded dependency-direction
note naming all three transaction-owning services, 5 new Risks (including the
`middleware.ts` fix, written up as a fix, not a still-open item), and Future Expansion
item 5 marked done. [docs/SETUP.md](./docs/SETUP.md) gained the 3 new secrets, the 4th
rate-limiter provisioning entry, and 2 new troubleshooting rows for the console-logged
OTP flow.

---

**Digital Loyalty module complete.** Across 8 blocks: a second, fully independent
identity system (SMS OTP, no platform login) layered onto the existing multi-tenant
foundation without modifying it; a transactional points engine with automatic tier
recalculation; a two-phase reward redemption flow; full customer- and staff-facing UI;
test coverage extended with a new pattern (integration-only for transaction-owning
services) the prior two modules never needed; and documentation kept in sync across all
four `docs/` files plus this README. One real pre-existing bug found and fixed along the
way (the `/feedback` middleware gap), and two gaps surfaced and deliberately left open
rather than scope-crept into fixes: no E2E coverage of the OTP customer flow, and
birthday-bonus/referral-code features that are schema-complete but not yet triggered by
any endpoint or job.

### AI Sentiment Analytics (module 4, complete)

Backend built across its own earlier blocks (schema: `feedback.sentiment`/
`sentimentScore`/`analysisStatus`/`analyzedAt` columns plus the append-only
`feedback_summaries` table; classification: `SentimentService` + a Cloudflare Queues
consumer that runs each new submission through the AI binding asynchronously so
`POST /qr/:token/feedback` never blocks on it; summary generation: `SummaryService`
aggregates a period's classified feedback and calls an LLM for a prose summary +
recommendations, capped at 100 comments per prompt as a cost/latency guardrail; API:
`GET /analytics/{trends,search,summaries}` (`analytics:view`) and
`POST /analytics/summaries/generate` (`analytics:manage`, since it costs a real
Anthropic call per invocation) in `apps/api/src/analytics/`). Staff gets neither
permission by default -- trend/summary data is business-strategy information, not a
front-counter task, a stricter cut than even `feedback:manage`.

What was missing going into this block: any dashboard UI at all consuming this API,
and a README section for the module (the first three modules each got one; this one
hadn't yet). Building the UI in sub-blocks, one at a time:

**Trend overview (done).** New `/dashboard/analytics` page plus an "Analytics" nav
link. Renders `GET /analytics/trends`'s day-bucketed positive/neutral/negative counts
as a stacked bar chart -- hand-rolled SVG (`components/ui/sentiment-trend-chart.tsx`),
not a charting library dependency, since a 30-90 point stacked bar chart with no
zoom/pan/tooltip needs is genuinely simple to render directly and a library would be
unused-surface-area for what this actually needs (same reasoning already applied to
`react-qr-code` vs. `qr-code-styling` in QR Engagement Block 4, just landing on "skip
the dependency entirely" this time instead of "pick the narrower one"). Branch
filtering reuses the native-`<select>`-plus-URL-param pattern from the feedback
inbox (Block 5) rather than waiting on a Select/Combobox primitive that still doesn't
exist -- kept as its own small file (`dashboard/analytics/branch-filter.tsx`) instead
of importing the feedback page's copy, since that component hardcodes
`/dashboard/feedback` as its navigation target and this app has no shared-but-not-
design-system component location yet to generalize it into.

**AI summaries panel (done).** Added to the same page: `SummaryGenerator` (a
period-type select + "Generate summary" button, `lib/actions/analytics.ts`'s
`generateSummaryAction`) and `SummariesList` (renders `GET /analytics/summaries`'s
results as cards with sentiment-count badges and the recommendations text split into
a list). `POST /analytics/summaries/generate` returns 202 with the job merely
queued -- `SummaryService` runs it async in the Cloudflare Queues consumer and can
involve a several-second LLM call -- so the generator is deliberately fire-and-confirm
("Queued -- refresh shortly"), not fire-and-wait; there's no polling. No `confirm()`
dialog on generate, unlike `QrCodeDialog`'s regenerate: this doesn't destroy anything,
it only queues a job, and the API's own `analytics:manage` gate (distinct from
`analytics:view`, specifically because this costs a real Anthropic call) is what
actually protects the cost -- a confirmation on top would just add friction to a
legitimate, non-destructive action. Generation and the summaries list always share
the page's branch filter rather than having a second selector, since
`FeedbackSummaryRepository.listForBusiness` treats "business-wide" and "one branch"
as two genuinely different report types that are never mixed in one query --
`branchId: undefined` means business-wide only, not "every branch," which the UI now
deliberately mirrors instead of assuming.

**Badge component extended:** added `success`/`danger` variants (tint-based,
`bg-{color}/10`, reusing the existing single-shade tokens) alongside the pre-existing
`brand`/`accent`/`neutral`, specifically for the summaries panel's sentiment-count
badges.

**Searchable feedback explorer (done).** New `/dashboard/analytics/search` page --
deliberately a separate page, not a third stacked section on the overview: analytics:view
is a genuinely different permission from feedback:manage (Staff has neither), and this
is read-only exploration with no Mark reviewed/Delete actions, unlike the feedback
inbox -- a user with only analytics:view may not hold feedback:manage at all, and
showing action buttons that would just 403 on click would be broken UX, not a
polish detail. Linked from the overview page ("Search feedback →", preserving the
current branch filter) rather than added as a second top-level nav item.

One combined filter bar (`search-filters.tsx`): branch, keyword (searches `comment`
only -- `FeedbackRepository.search` deliberately excludes customerName/Email/Phone
from free-text search, so this doesn't become an accidental PII lookup tool beyond
what `feedback:view` already grants), sentiment, rating, and a date-range *preset*
select (7/30/90/365 days) rather than two raw date-picker inputs -- no date-picker
primitive exists in this design system, and named presets cover realistic use cases
without that complexity. All five submit together as one real `<form>`, not
independently-navigating selects like `BranchFilter`'s single-field pattern -- with
this many fields, applying one at a time would clobber the others mid-edit. Offset
always resets to 0 on a new search (a stale page-2 offset combined with a materially
different result set wouldn't be a real "page 2 of this search"). Reuses the same
"fetch limit+1, Older/Newer" pagination trick as the feedback inbox --
`FeedbackRepository.search` has no total-count query either.

**Backend unit tests (done).** Five new co-located `*.test.ts` files, zero coverage
existed before: `sentiment-classifier.test.ts` (score signing, neutral-band bucketing,
the deterministic rating fallback never touching the AI binding), `sentiment.service.test.ts`
(comment-vs-rating branch selection, idempotent overwrite on redelivery, marks `failed`
and rethrows rather than leaving a row stuck at `pending`), `period.test.ts` (weekly/
monthly range math, doesn't mutate its `now` argument), `analytics.service.test.ts`
(date-range validation: invalid strings, `from`&gt;`to`, the 366-day cap and its exact
boundary), `summary.service.test.ts` (sentiment counting, the 100-comment prompt cap,
`branchId: null` for business-wide summaries, `BUSINESS_NOT_FOUND`/`BRANCH_NOT_FOUND`).
Fakes for `FeedbackRepository`/`FeedbackSummaryRepository`/`BusinessRepository`/
`BranchRepository` are cast (`as unknown as X`) rather than passed structurally --
unlike `BranchRepository` (6 methods, matched exactly by Branch Mgmt's fake with no
cast needed), these repositories have more methods than any single service under test
calls, so a same-shape fake doesn't satisfy the full type on its own.

**Frontend component tests (done).** `summary-generator.test.tsx` covers the
weekly/monthly period selection, correct `{periodType, branchId}` passed to
`generateSummaryAction`, the async "Queued" confirmation (not a completed summary --
generation is async), the inline error path, and confirms no `confirm()` dialog fires
(matches `feedback-actions.test.tsx`'s established pattern for asserting an action is
deliberately non-blocking). `search-filters.test.tsx` covers default submission
(only `range=30` present, every other filter omitted when unset), full multi-filter
submission with correct URL encoding, and pre-fill-from-props for every field.
First **test file** in this app to mock `next/navigation`'s `useRouter` -- note this is
narrower than "first component to use client-side navigation": both `BranchFilter`
components (feedback inbox and this module's own) have called `useRouter().push()`
since QR Engagement Block 5, they just never had their own unit test. What's genuinely
new here is the mock itself, `vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))`,
establishing the pattern for any future client-side-navigation component test.

**Documentation (done).** Full endpoint reference for the 4 analytics routes plus the
previously-undocumented `POST /feedback/:id/reanalyze`, 2 new error codes
(`INVALID_DATE_RANGE`/`DATE_RANGE_TOO_LARGE`), and the `analytics:view`/`analytics:manage`
permissions added to [docs/API.md](./docs/API.md). [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
updated: Component Responsibilities (`src/sentiment/`, `src/analytics/`,
`apps/web`'s analytics screens, the cron `scheduled` export), Security Architecture
(Staff's exclusion from analytics, the search PII boundary, AI cost control), Risks &
Known Gaps (no polling on async generation, no per-branch auto-summary schedule, the
fake-repo casting pattern), and Future Expansion item 4 marked done.

**Review pass (done, 2026-07-10).** A dedicated review after the module was first
marked complete caught real inaccuracies before they could mislead future work: the
initial docs pass wrongly claimed no scheduled summary generation existed, when
`src/index.ts`'s `scheduled` export (weekly Monday + monthly 1st, business-wide only)
already covers it; `POST /feedback/:id/reanalyze` was missing from API.md entirely;
and `docs/SETUP.md` never received its own Sentiment Analytics pass, so it was missing
the `ANTHROPIC_API_KEY` secret command, the `echo-grid-feedback-jobs-dlq` provisioning
command, and the `.dev.vars` example line -- same "stale doc copy of an example file"
pattern flagged before in Branch Mgmt Block 7 and QR Engagement Block 2. All fixed in
this pass; see the Changelog in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the
full list.

**AI Sentiment Analytics module complete** (Blocks 1-7: schema, classification
pipeline, summary generation, read API, dashboard UI, testing, documentation).

### Notifications (module 5, complete)

1. Schema (`notification_preferences`, `notifications`, `business_notification_settings`) — **done**
2. Delivery infrastructure (email/SMS services, queue wiring) — **done**
3. Business logic (templates, `NotificationService`, 6 trigger points) — **done**
4. API (self-service preferences, business settings, send log) — **done**
5. UI (staff dashboard + customer screen) — **done**
6. Testing — **done**
7. Documentation — **done**

Selected via `AskUserQuestion` over i18n/multi-currency UI and a platform
admin console, the two other items still open on the Future Expansion
roadmap at the time.

**Schema.** Three new tables. `notification_preferences` has nullable
`userId`/`customerId` columns with a CHECK enforcing exactly one is set, plus
**two separate partial unique indexes** (one `WHERE userId IS NOT NULL`, one
`WHERE customerId IS NOT NULL`) rather than one combined index -- Postgres
treats `NULL != NULL` in uniqueness checks, so a single index spanning both
nullable columns would silently fail to prevent duplicate rows on whichever
side is null for a given row. `notifications` is an append-only send log
(mirrors `audit_log`/`loyalty_transactions`), snapshotting `recipientAddress`
at send time rather than joining live, so a log entry stays accurate even if
a recipient later changes their email. `business_notification_settings` is a
lazy get-or-create row per business (mirrors `loyalty_settings`) holding
email/SMS kill switches and `maxSmsPerDay` (default 50) -- a real cost-abuse
vector exists because public unauthenticated feedback submission can trigger
an SMS via `feedback_received`. Two new permissions, `notifications:view`/
`notifications:manage`, granted to Owner/Admin/Manager only -- Staff
excluded, the same cut Analytics already established for business-strategy/
cost-control concerns. Self-service preference management needs no
permission at all, for either identity system.

**Delivery infrastructure.** `EmailService` (`ResendEmailService` +
dev-fallback `ConsoleEmailService`) calls Resend's REST API via plain
`fetch()`, not an SDK -- the same Workers-runtime-compatibility reasoning
already established for Twilio/Anthropic. Live-searched the transactional
email landscape before choosing: Cloudflare shipped a native Email Service
binding shortly before this block, architecturally preferable long-term (no
API key, cheaper), but only weeks out of beta -- too new a dependency for a
platform whose own standing instructions demand "enterprise-grade"
reliability, so Resend won for v1, flagged as a one-file (`EmailService`
interface) swap candidate once the native binding has more track record.
`SmsService` is reused **completely unchanged** from Digital Loyalty -- it
was already a generic `send(phone, body)`, zero OTP-specific coupling.
`SendNotificationJob` carries a fully resolved send request (recipient
address, rendered subject/body), not raw event data -- every preference/cap/
kill-switch decision happens before enqueueing, keeping the queue consumer
itself dumb, the same design `ClassifyFeedbackJob` already established. The
shared `JOBS` queue's message type widened to a `PlatformJob` union
(`SentimentJob | SendNotificationJob`) rather than provisioning a second
queue -- both job types are lightweight, bounded background work with no
isolation need at this platform's current scale.

**Business logic.** `notification-templates.ts` renders all 6 event types'
subject/email/SMS copy from one function per event, HTML-escaping every
user-controlled string (business/branch/reward names, feedback comments)
before it reaches the email body -- a real stored-XSS-in-email vector since
feedback comments are public, unauthenticated input. `NotificationService.notify()`
checks, in order: does the recipient have an address for this channel, is
the channel enabled business-wide, has the SMS cost cap been hit, has the
recipient explicitly opted out -- each skip is silent and expected, and one
channel failing to enqueue never blocks the other. The one platform-wide
architectural rule enforced at all **6 trigger points**: every notification
fires from a route handler (or the queue consumer) strictly **after** the
owning operation's transaction has already committed -- never from inside a
`db.transaction()`-owning service like `LoyaltyAccountService`. Wiring a
`.send()` into the same transaction as a DB write would create a dual-write
problem (no atomicity between a Postgres commit and a Cloudflare Queues
send); this mirrors the precedent `qr.routes.ts`'s sentiment-classification
enqueue already set.

**API.** Self-service endpoints (`GET`/`PATCH /notifications/preferences`
for staff, `GET`/`PATCH /loyalty/me/notification-preferences/:businessId`
for customers) need no permission -- same reasoning as a customer managing
their own loyalty account. Both return a **materialized** grid (every
eventType x channel combination, not just rows that happen to exist in the
database) so a settings screen never has to re-derive "no row means enabled"
itself. Business-wide settings and the send log are gated behind the two new
permissions.

**UI.** Staff dashboard (`/dashboard/notifications`) stacks three Cards on
one page rather than a subnav or separate routes -- unlike Loyalty's 5
screens, none of these three views has URL-addressable state (filters,
pagination params) that would justify its own route. Customer screen
(`/loyalty/dashboard/[businessId]/notifications`), linked from the account
page. New `Switch` design-system primitive -- the first boolean-toggle need
in this app; a plain `<input type="checkbox">` styled as a pill, not a
custom `role="switch"` div, the same "native element already has full
keyboard/AT support" reasoning as every other primitive. The preferences
grids are controlled `useState` plus an imperative Server Action call
(mirrors `RewardRowActions`'s pattern), not `useActionState` + FormData --
the PATCH payload is a nested array FormData represents poorly. **Found
while building this:** the app has no client-side permission-hiding anywhere
(verified by grep, zero matches across `apps/web`) -- a Staff member without
`notifications:view` hitting this page gets the API's error surfaced by
Next's default error handling, the same pre-existing gap Analytics already
has with `analytics:view`. Notifications' UI matches that existing
convention rather than patching it as a one-off; worth a platform-wide fix
later.

**Testing.** Scoped to logic-bearing code, matching this codebase's actual
established coverage pattern (presentational primitives like `Button`/
`Card`, and now `Switch`, stay untested everywhere in this app):
`notification-templates.test.ts` (rendering + XSS-escaping across all 6
event types), `notification.service.test.ts` (kill switches, the SMS cap,
opt-out, staff broadcast + permission filtering, preference materialization),
and 2 frontend suites for the staff/customer preference forms. One real bug
caught during the debug pass, before it shipped: a test helper's
`makeSettings()` wasn't spreading its `overrides` argument, which would have
silently broken the kill-switch and SMS-cap test cases.

**Documentation (this section).** [docs/API.md](./docs/API.md) gained full
reference for 7 new endpoints, 2 new permissions, and the role-grant table's
stale "18 keys" corrected to 20. [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
gained Component Responsibilities rows, 3 new Security Architecture rows, 4
new Risks (push not implemented, the Resend-vs-native-binding tradeoff,
`Queue<PlatformJob>`'s contravariant typing never compiler-verified, and
`feedback_summaries` missing from the ERD — see below), Future Expansion
item 6 marked done, and a full N-1 through N-7 Changelog section.
[docs/ERD.md](./docs/ERD.md) gained full diagram + field-table entries for
all 3 new tables. Two pre-existing drifts caught along the way, not
introduced by this module: both ARCHITECTURE.md and ERD.md still said the
permissions catalog had 16 keys across 7 categories, stale since AI
Sentiment Analytics brought it to 18 across 8 -- both corrected to the
current 20/9 here. Also found, and deliberately left for its own future fix
rather than scope-creeped into this module: ERD.md was never updated when
AI Sentiment Analytics added `feedback_summaries` -- flagged in
ARCHITECTURE.md's Risks table.

---

**Notifications module complete.** Across 7 blocks: 3 new tables with a
partial-unique-index design that avoids a real Postgres NULL-uniqueness
pitfall; email + SMS delivery for 6 transactional events across both
identity systems; a strict transaction-then-notify ordering enforced at
every trigger point to avoid a dual-write race; self-service preferences
with zero permission overhead alongside cost-controlled business-wide
settings; a new design-system primitive; and test coverage scoped to logic,
not boilerplate, that caught one real test-helper bug before it shipped.

### Internationalization & Multi-Currency UI (module 6, complete)

1. Backend: business locale/currency/timezone settable — **done**
2. next-intl infrastructure — **done**
3. Settings UI + hardcoded formatting fixes — **done**
4. Dashboard shell + auth translation — **done**
5. Branch Management + QR Engagement translation — **done**
6. Digital Loyalty translation — **done**
7. AI Sentiment Analytics + Notifications translation — **done**
8. Testing — **done**
9. Documentation — **done**

The last item on the Future Expansion roadmap besides the platform admin
console (item 8): `businesses.default_locale`/`default_currency` had existed
in the schema since the Foundation, unconsumed by `apps/web`'s rendering
layer until this module. Full-UI-translation was the chosen scope (offered
alongside a narrower "format numbers/dates only, leave text English" option
via `AskUserQuestion`) -- English, Spanish, and French ship as real
first-class languages, not just locale-aware number formatting bolted onto
an English-only UI.

**Backend settability.** `packages/shared-types/src/i18n.ts` (new) defines
`SUPPORTED_LOCALES = ['en', 'es', 'fr']` as a **closed Zod enum, not a
freeform BCP-47 string** -- deliberately, because `defaultLocale` drives both
Intl formatting (which would accept almost any tag) and UI string lookup
(which only resolves for languages this app actually ships translations
for). Allowing an untranslated tag here would silently produce a
half-localized business (correct number formats, English-only text), worse
than not offering the option at all. Enforced at two layers for defense in
depth: `localeSchema` (Zod, request-time) and a new
`businesses_default_locale_check` CHECK constraint (`IN ('en','es','fr')`,
database-time) -- the same "belt and suspenders" pattern this schema already
uses for every other `status`/enum-shaped text column.
`defaultCurrency`/`defaultTimezone` deliberately stay **open** (regex/length
validated only, no enum) since they only feed Intl formatting, not string
lookup -- matching `branches.countryCode`/`branches.timezone`'s existing
no-exhaustive-validation precedent, and not needing a code deploy every time
a business in a new country signs up. New `PATCH /businesses/me` (not
`/:id` -- matches `GET /businesses/me`'s existing precedent, and
`X-Business-Id` already disambiguates which business) reuses the
pre-existing `business:manage_settings` permission rather than minting a new
one. `GET /businesses/:id/public` and `GET /qr/:token` -- both already
public, anonymous-reachable endpoints -- were widened to include the three
fields for free, since both handlers already load the full business row;
this is what lets a customer's QR check-in page and loyalty dashboard render
in the *business's* locale with no session of their own.

**next-intl infrastructure.** Adopted in next-intl's documented **"without
i18n routing"** mode -- no `[locale]` URL segment, since locale here is a
*business setting*, not something an individual visitor picks, unlike the
typical marketing-site i18n use case next-intl's own routing features
target. Locale resolution has to branch three ways depending on *who* is
asking, since there's no single session type that covers every visitor:

- **Staff** -- root `apps/web/src/i18n/request.ts`'s `getRequestConfig`
  resolves the active business's locale via a new `getActiveBusinessQuiet()`
  (`lib/business.ts`), gated behind a cheap `hasSession()` cookie check first
  so a fully anonymous request never pays for a wasted API call. Deliberately
  **not** a reuse of the existing `getActiveBusiness()` -- that function
  `redirect()`s to `/login` on a 401, and this config runs on *every* request
  including fully public ones; reusing it risked either hijacking an
  anonymous page with a surprise redirect or silently swallowing Next's
  internal redirect signal in a catch block. `getActiveBusinessQuiet()`
  shares the same underlying fetch via an extracted private
  `fetchBusinessList()` rather than duplicating it.
- **Customer** -- `app/loyalty/dashboard/[businessId]/layout.tsx` fetches
  that one business's public info and nests its own `NextIntlClientProvider`,
  overriding the root's. `NextIntlClientProvider` is next-intl's own
  documented nestable pattern -- exactly what a platform with more than one
  simultaneous "whose locale is this" context needs.
- **Anonymous QR** -- `feedback/[token]/page.tsx` and `loyalty/[token]/page.tsx`
  each wrap their own provider using the QR resolve response's own
  `defaultLocale` (free, per the backend widening above) -- no session,
  staff or customer, exists at all on these routes.

Messages live one JSON file per feature module under
`apps/web/messages/<locale>/<namespace>.json` (`common`, `dashboard`, `auth`,
`branches`, `feedback`, `loyalty`, `analytics`, `notifications` -- 8
namespaces × 3 locales, 24 files), matching this app's existing feature-based
folder convention rather than one ever-growing monolith. `i18n/load-messages.ts`'s
`loadMessages()` dynamically imports every namespace per request using a
`NAMESPACES` const array over a template-literal import path -- next-intl's own
documented "context module" technique for split message files, not an
arbitrary runtime path the bundler couldn't statically analyze.

**Settings UI + formatting fixes.** New `/dashboard/settings` page
(business name, locale, currency, timezone) -- and with it, this design
system's **first Select primitive** (`components/ui/select.tsx`), closing a
gap flagged as far back as Branch Management Block 5, where country
code/timezone stayed plain text inputs for lack of one. `useFormatter()`/
`getFormatter()` (next-intl's Intl wrapper, with a `formats` preset for
`short`/`shortDateTime` defined once in `i18n/request.ts`) replaced every
hardcoded date/currency literal this session could find: the loyalty
dashboard's transaction timestamps, the AI summaries panel's period labels,
the feedback inbox and analytics search's submission dates, the
notification send log's timestamps (`shortDateTime`, not `short` -- the one
call site where the time genuinely matters), and loyalty settings' `$1`
placeholder (now `format.number(1, {style: 'currency', currency})`,
correctly positioned and symbol-correct per the business's own
`defaultCurrency`).

**Dashboard shell + auth translation.** `dashboard.json`/`auth.json`
namespaces cover the nav, home screen, business-creation form, and the
login/signup pages. This is also where `apps/web`'s test suite first needed
its own new infrastructure: `src/test-utils.tsx`'s `renderWithIntl()`, a
`NextIntlClientProvider`-wrapped drop-in for React Testing Library's
`render()`, needed the moment the first Client Component under test called
`useTranslations()` and threw "no context found" against a bare `render()`.
Its `rerender` deliberately re-wraps whatever element it's given in the same
provider rather than returning RTL's raw one -- RTL's real `rerender()`
replaces the *entire* previous tree, provider included, which would have
broken the first test that called it twice in a row (caught in Digital
Loyalty's translation pass, Block 6 below). Every subsequently-translated
Client Component's test file needed the same `render` → `renderWithIntl`
swap; by the end of this module, 13 test files across 5 modules had it.

**Branch Management + QR Engagement translation.** `branches.json`/
`feedback.json`. One accepted, documented limitation:
`feedback/[token]/not-found.tsx` cannot render in a QR's *own* business
locale, because the entire reason a visitor lands there is that the token
never resolved to a business in the first place -- there is no locale signal
left to read. It falls back to the root default (English) by design, noted
in-code rather than worked around.

**Digital Loyalty translation.** `loyalty.json` -- the largest namespace at
142 keys, covering both the staff side (accounts, tiers, rewards, redemption
counter, settings) and the customer side (login, shell, my rewards, business
dashboard, reward redemption, QR check-in). Two mid-block corrections, both
caught and fixed before shipping: an inline `useTranslations(...)('manage')`
call inside a JSX expression in `account-dialog.tsx` violated the Rules of
Hooks (a hook can't be invoked mid-render inside an expression) -- fixed by
relocating that key to the component that actually owns the text and using
its already-declared top-level translator; and a pending-state text swap
added to `delete-tier-button.tsx` that didn't exist in the original
component (unlike its sibling `delete-branch-button.tsx`, which does have
one) was reverted as unrequested scope creep on what was meant to be a
translation-only pass.

**AI Sentiment Analytics + Notifications translation.** `analytics.json`/
`notifications.json`. The one real architectural wrinkle this module
surfaced: `lib/notification-preferences.ts` used to export
`NOTIFICATION_EVENT_LABELS`/`NOTIFICATION_CHANNEL_LABELS` as static
module-level `Record` objects, shared by both the staff and customer
preference forms -- but `useTranslations()`/`getTranslations()` can only be
called inside a component, never in a plain object literal evaluated at
module load. Both Records were removed; each consumer now calls
`t(\`events.${eventType}\`)`/`t(\`channels.${channel}\`)` directly against
one shared `notifications` namespace (not split staff/customer), which is
what keeps the label text itself de-duplicated across the two otherwise
fully independent form components -- and matches what their pre-existing
tests already asserted (byte-identical English wording on both sides). Two
self-caught bugs during this pass, the same *class* of mistake in two
different files: `dashboard/analytics/search/page.tsx` and
`dashboard/notifications/notification-log.tsx` were both rendering a raw
lowercase enum value (`item.sentiment`, `entry.status`) directly as visible
badge text -- a leftover hardcoded string in effect, just sourced from data
instead of JSX literal. Both now route through proper translation keys.

**Testing.** `packages/shared-types` -- home of `resolveSupportedLocale`,
the one guard every locale-resolution call site in this app relies on -- has
no test runner of its own (no `vitest`, no config, zero existing tests for
*any* of its exports). Rather than standing up new test infrastructure for a
single pure function, its main consumer (`apps/web`, which already has a
working Vitest setup) covers it at the integration boundary instead: new
`i18n/resolve-supported-locale.test.ts` (valid locales, unsupported tags,
null/undefined/empty, case-sensitivity) and `i18n/load-messages.test.ts`
(exercises the real dynamic-import path for all 3 locales -- a missing or
malformed namespace file fails a test instead of a page). Structural
key-parity across all 24 message files was spot-checked by key-count
comparison (373 keys, identical per-namespace breakdown across en/es/fr) --
this session's sandbox was unavailable for its entire duration (see Known
Gaps), so this was **not** confirmed with an actual `pnpm test`/`pnpm
typecheck` run; that's the first thing to do before building further on
this module.

**Documentation (this section).** [docs/API.md](./docs/API.md) gained the
new `PATCH /businesses/me` endpoint and updated response examples for `GET
/businesses/:id/public` and `GET /qr/:token` (both widened with the 3 new
locale/currency/timezone fields). [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
gained Component Responsibilities rows for `apps/web`'s `i18n/` directory and
`messages/`, a Dependencies row for `next-intl`, new Risks (the closed
3-locale enum needing a code deploy to extend, `packages/shared-types`
having no test runner, the not-found.tsx locale limitation), and Future
Expansion item 7 marked done. [docs/ERD.md](./docs/ERD.md)'s
`businesses.default_locale` row is corrected from "BCP-47 tag" (aspirational
wording predating this module) to accurately describe the closed 3-value
CHECK constraint now enforcing it.

---

**Internationalization & Multi-Currency UI module complete.** Across 9
blocks: locale/currency/timezone promoted from unconsumed schema columns to
a fully wired three-context provider architecture (staff, customer,
anonymous QR); a closed-enum locale design enforced at both the Zod and
database layers; full English/Spanish/French translation across all 8
feature-module namespaces (373 keys × 3 locales); this design system's first
Select primitive; a reusable `renderWithIntl()` test helper now used by 13
test files; and two self-caught raw-enum-as-badge-text bugs fixed before
they shipped. One real limitation accepted and documented, not worked
around: a QR token that never resolves to a business has no locale to
render its 404 in. Verification caveat carried over from every prior module
this session: not yet confirmed against a real `pnpm test`/`pnpm typecheck`
run.

### Platform Admin Console (module 7, complete)

1. Schema & platform admin identity — **done**
2. Cross-tenant business directory backend — **done**
3. Cross-tenant audit log backend — **done**
4. Impersonation backend — **done**
5. Platform admin UI shell — **done**
6. Business directory + audit log UI — **done**
7. Impersonation UI — **done**
8. Billing schema + Stripe integration backend — **done**
9. Business-facing billing UI — **done**
10. Platform-admin billing UI — **done**
11. Testing — **done**
12. Documentation — **done**

The last item on the original Future Expansion roadmap: cross-tenant support/
billing/admin operations need their own permission tier above business-scoped
RBAC, deliberately deferred until every other module had shipped so this
console's audit log, business directory, and (once Billing landed) MRR
reporting would have real cross-tenant data to actually show. One real scope
addition beyond the roadmap item's original wording ("support, billing, abuse
response"): platform SaaS billing (Stripe-backed subscriptions, plan catalog,
card-less trials) grew large enough to become half the module's block count.
Abuse-response tooling beyond suspend/reactivate/archive was not built -- see
Risks & Known Gaps.

**Schema & identity (Block 1).** One new nullable column, `users.platform_role`
(`support | billing | admin`, CHECK-constrained, deliberately **not** in
`packages/shared-types` since it has no tenant-facing route). NULL for the
overwhelming majority of accounts. Layered on top of, never a replacement for,
business-scoped `user_business_roles` -- one person can hold both a platform
role and an ordinary Owner/Admin/Manager/Staff grant. Not a hierarchy: `support`
gets read-only cross-tenant visibility plus impersonation; `billing` gets the
same read-only visibility plus subscription/plan management (Block 8) but
explicitly *not* impersonation, once Block 4 made clear the two are orthogonal
(viewing a business's dashboard as its own staff has nothing to do with
managing what it pays); `admin` gets everything, including suspending
businesses and granting other users' platform roles. There is no invite flow
for platform roles (that's a business-side concept) -- a new
`db:seed:platform-admin` script bootstraps the first account able to log
into `/platform` at all, reading credentials from env rather than
hardcoding them; idempotent, so re-running it also restores a revoked role
without a separate script. A new `requirePlatformRole(allowedRoles)` middleware
(`apps/api/src/middleware/require-platform-role.ts`) enforces this as an
explicit per-route allow-list, not an implied hierarchy -- a route scoped to
`['billing']` does not silently admit `admin` unless it says so. It re-resolves
`platformRole` from the database on every request rather than trusting the
JWT (the same "authorization is never cached in the token" rule
`resolveTenantContext` already follows) and re-checks `status === 'active'` as
defense in depth, since this is the highest-blast-radius surface in the system.

**Backend (Blocks 2-4).** Three new route files under `apps/api/src/platform/`,
all genuinely cross-tenant (no `X-Business-Id`, no `resolveTenantContext`
anywhere in the module). `business-directory.routes.ts`:
`GET /platform/businesses` (search + status filter + pagination, open to every
platform role), `GET /platform/businesses/:id`,
`GET /platform/businesses/:id/team` (hydrated with user email/name, backs the
impersonation picker), and `PATCH /platform/businesses/:id/status`
(suspend/reactivate/archive, `admin`-only -- support/billing get read access
but not the ability to take a paying customer offline). Status changes set
`auditMetadata` explicitly with the affected `businessId`, since there's no
tenant context here to fall back on the way `resolveTenantContext`-scoped
routes get it for free. `audit-log.routes.ts`: `GET /platform/audit-log`, the
cross-tenant counterpart to the existing per-business
`GET /businesses/audit-log`, hydrated with business/actor names and filterable
by business, actor, entity type, action, and date range, open to every
platform role (support's whole purpose is cross-tenant visibility for
debugging). Impersonation (`POST /platform/businesses/:id/impersonate`,
`support`/`admin` only) is its own `ImpersonationService`: validates the
target user exists and is active, then that they actually hold an active role
grant at the *named* business -- without that second check an admin could
impersonate anyone while claiming to be "at" a business the target has
nothing to do with, making the resulting session's permissions meaningless.
On success it mints a short-lived (30 min), **non-renewable** access token via
a new `signImpersonationToken` (no refresh token, so a session can't silently
extend itself -- the admin re-initiates through the same endpoint when it
expires, re-validating and re-logging every time) carrying an
`impersonatedBy` claim. Everything downstream -- `authenticate`,
`resolveTenantContext`, every ordinary tenant route -- sees exactly the token
it would for the target's own real session, so impersonation needed zero
special-casing anywhere else in the API; the claim exists purely so
`authenticate` can surface it for the audit trail.

**Platform admin UI shell (Block 5).** New `/platform` route tree in
`apps/web`, gated by three layers: `middleware.ts`'s existing refresh-cookie
presence check, a `hasSession()` re-check (same defense-in-depth as
`dashboard/layout.tsx`), and -- unique to this section -- a
`getCurrentUser().platformRole` check that renders an explicit access-denied
view rather than a silent redirect, since a valid staff session alone isn't
enough and a silent bounce back to `/dashboard` would look like a bug rather
than the deliberate rejection it is. New `GET /auth/me` (any authenticated
user can call it; `platformRole` is simply `null` for almost everyone) backs
`lib/platform.ts`'s `getCurrentUser()`, wrapped in React's `cache()` so the
several independent places in the tree that need "who is this" (the layout
guard, the dashboard home's conditional "Platform Admin" card, the
impersonation banner) share one call per request instead of firing it
repeatedly.

**Business directory + audit log UI (Block 6).** List/detail/status-change
screens for the directory, and a filterable list for the platform-wide audit
log -- straightforward Server Component + Server Action pairs following this
app's existing patterns, no new architectural ground.

**Impersonation UI (Block 7).** An "Impersonate" button plus a reason-required
confirm dialog on the business detail page, and -- the more interesting half
-- an always-visible warning banner (`dashboard/impersonation-banner.tsx`) in
the *target's own* dashboard chrome for the duration of the session, so an
admin can never navigate somewhere within the impersonated dashboard and lose
track of the fact that they're viewing it as someone else. Backed by a real
admin-token stash: starting impersonation stashes the platform admin's own
access+refresh token pair in separate cookies before overwriting the main
session cookies with the impersonation token; stopping it (the banner's "Stop"
button, `stopImpersonationAction`) restores the stashed pair and clears the
stash, or falls back to a clean logout if the stash is missing (expired, or
`stopImpersonation` called without a preceding start) rather than leaving the
admin in an ambiguous half-impersonating state. `isImpersonating()` is a free
cookie-presence check gating whether the banner (and its one paid `/auth/me`
call) mounts at all, so ordinary dashboard loads pay nothing extra.

**Billing schema + Stripe backend (Block 8).** Two new tables:
`subscription_plans` (global catalog, never hard-deleted -- `isActive: false`
retires a plan from the picker while keeping it resolvable for grandfathered
subscribers; a partial unique index enforces at most one `isDefaultTrial`
plan platform-wide) and `business_subscriptions` (one row per business, a
read-optimized mirror of Stripe subscription state, kept in sync by the
webhook handler so the dashboard never needs a live Stripe call to render
"you're on the Growth plan"). Every new business gets a **card-less 14-day
trial** auto-provisioned inside `BusinessService.createBusiness`'s existing
transaction (`SubscriptionProvisioningService`, mirrors
`RoleProvisioningService`'s shape exactly) -- no forced credit card at signup,
a deliberate conversion-focused product decision. Two new permissions,
`billing:view`/`billing:manage`, with Admin getting view-only and Owner alone
getting `:manage` -- the same irreversible/financially-consequential cut
already established for `business:delete`. Stripe is the one integration in
this codebase using the official SDK rather than plain `fetch()` (every other
third-party call -- Twilio, Resend, Anthropic -- avoids the Node SDK over
unverified Workers-runtime compatibility): Cloudflare and Stripe jointly ship
documented native Workers support (`Stripe.createFetchHttpClient()` +
`createSubtleCryptoProvider()`), and Stripe's request shapes are meaningfully
more complex than a flat JSON body. `POST /webhooks/stripe` is mounted at the
**root** Hono app, outside `/api/v1` entirely (same precedent as `/health`),
both to skip CORS/rate-limit/auth middleware that has no business touching an
unauthenticated webhook and to sidestep a real Workers/Hono gotcha (the raw
request body must be read once, before any global middleware touches it, for
signature verification via `constructEventAsync` to succeed). The sync reacts
only to `customer.subscription.*` events (not `checkout.session.completed`),
correlating each event to a business via `subscription_data.metadata` set at
Checkout time, and is idempotent by upsert construction
(`ON CONFLICT (business_id) DO UPDATE`) rather than an event-ID dedup ledger
-- a deliberate v1 scope call, since this mirrors absolute state rather than
incrementing a value.

**Business-facing billing UI (Block 9).** `/dashboard/billing`: a current-plan
card (status badge, trial/renewal/cancellation dates), a plan picker with
separate monthly/yearly buttons per plan, and a "Manage billing" button gated
behind `hasPaymentAccount` (a derived boolean -- the API never returns a raw
Stripe customer/subscription/price ID to the browser under any circumstance,
stricter treatment than most internal fields this codebase otherwise
tolerates leaking, since these are live external payment-processor
identifiers). Both actions redirect to a Stripe-hosted page (Checkout for a
new/changed subscription, Customer Portal for everything after) -- this
platform never handles a card number or builds its own payment form.

**Platform-admin billing UI (Block 10).** `/platform/billing`: an MRR summary
card backed by a real SQL `SUM`/`COUNT` aggregate (not fetch-every-row-and-
reduce-in-JS), a paginated, status-filterable cross-tenant subscription list,
and a linked `/platform/billing/plans` screen for plan CRUD (`billing`/`admin`
only to mutate). Platform-admin DTOs *fork* rather than widen the
business-facing billing contract -- admins legitimately need Stripe price IDs
the business-facing contract deliberately excludes, the same audience-split
precedent `platformBusinessSchema` already established against `businessSchema`.

**Testing (Block 11).** Fake-repository unit tests (no mocking library, this
codebase's standing convention) for `SubscriptionProvisioningService`,
`BillingService` (including a hand-written fake Stripe client typed via
`Parameters<Stripe['checkout']['sessions']['create']>[0]` rather than a
guessed SDK namespace path), and `StripeWebhookService` (event routing,
price-to-plan resolution with a metadata fallback, and -- the trickiest case
-- `customer.subscription.deleted` correctly forcing `canceledAt` to "now"
even when the payload carries its own, stale `canceled_at`). One new
`test/integration/billing-permissions.integration.test.ts`, extending the
existing `permission-resolution.integration.test.ts` precedent against real
Postgres, confirms the Owner-vs-Admin `billing:manage` cut resolves correctly
end to end, not just in the seed data's intent.

**Documentation (this section).** [docs/API.md](./docs/API.md) gained full
reference for 17 new endpoints (business directory, platform audit log,
impersonation, `GET /auth/me`, business-facing billing, platform billing, the
Stripe webhook) and 13 new error codes. [docs/ERD.md](./docs/ERD.md) gained
`users.platform_role` and full field references for
`subscription_plans`/`business_subscriptions`.
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) gained a new Multi-Tenancy
Model bullet, Component Responsibilities rows for `src/platform/`/
`src/billing/` and their `apps/web` counterparts, new Security Architecture
rows (platform authorization, impersonation, webhook verification), a
`stripe` Dependencies row, new Risks, and Future Expansion's final item marked
done. [docs/SETUP.md](./docs/SETUP.md) gained the two new Stripe secrets and
the plan-catalog seed commands.

---

**Platform Admin Console module complete.** Across 12 blocks: a cross-tenant
permission tier layered on top of business-scoped RBAC without touching it; a
searchable business directory and platform-wide audit log; time-boxed,
non-renewable impersonation with a real admin-token-stash exit path and an
always-visible target-side banner; and a full Stripe-backed platform SaaS
billing system -- card-less trials, hosted Checkout/Portal, a
signature-verified webhook sync, and both a business-facing and
platform-admin billing UI. This closes out every item on the original Future
Expansion roadmap. Same standing caveat as every prior module: not yet
verified against a real `pnpm install && pnpm typecheck && pnpm test` run,
sandbox unavailable this entire session (and every session before it).
