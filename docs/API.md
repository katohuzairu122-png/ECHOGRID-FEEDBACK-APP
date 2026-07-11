# API Contract Reference

Base URL (local dev): `http://localhost:8787`. All routes except `/health` are
versioned under `/api/v1`. There is currently one version; breaking changes
will ship as `/api/v2` rather than mutating v1's contract.

## Conventions

**Response envelope** — every response, success or error, uses one of two
shapes:

```json
// success
{ "success": true, "data": { } }

// error
{ "success": false, "error": { "code": "STRING_CODE", "message": "Human-readable.", "details": null } }
```

`details` is omitted or `null` unless a specific error includes structured
extra data (e.g. validation issues, the required permission key).

**Authentication** — `Authorization: Bearer <accessToken>` header, required on
every route except `/health`, `/api/v1/auth/signup`, `/api/v1/auth/login`,
`/api/v1/auth/refresh`. Access tokens expire in 15 minutes; use
`/api/v1/auth/refresh` to get a new pair before then.

**Tenant context** — routes that operate within a specific business additionally
require an `X-Business-Id: <uuid>` header, and optionally `X-Branch-Id: <uuid>`
to scope to one branch. The caller must hold an active (non-revoked) role grant
at that business. *(Header-based for now — a route-param convention such as
`/businesses/:businessId/...` is the likely future replacement once more
business-scoped routes exist; see ARCHITECTURE.md's Risks section.)*

**Pagination** — list endpoints accept `?limit=&offset=` query params, both
optional integers.

**Rate limits** — `POST /api/v1/auth/signup` and `POST /api/v1/auth/login`: 10
requests/minute, keyed by client IP. The public `/api/v1/qr/*` routes (QR
Engagement): 20 requests/minute, keyed by client IP — this platform's only
anonymous *feedback* write surface, so it gets its own stricter limiter on
top of the general one. `POST /api/v1/customer-auth/otp/*` (Digital
Loyalty): 3 requests/minute, keyed by client IP — the strictest limiter on
the platform, since each `otp/request` call costs real SMS money via
Twilio, unlike a free feedback submission. Every other `/api/v1/*` route:
300 requests/minute, keyed by client IP. All limiters stack with the
general one; exceeding any returns `429`.

**Two separate identity systems** — this API has staff auth
(`Authorization: Bearer <accessToken>` signed with `JWT_ACCESS_SECRET`,
`type: 'access'`) and, since Digital Loyalty, *customer* auth
(`Authorization: Bearer <accessToken>` signed with a completely separate
`CUSTOMER_JWT_SECRET`, `type: 'customer_access'`). The two token types can
never verify against each other, even by accident, because they're signed
with different secrets. Routes under `/api/v1/loyalty/*` (no further path
segment) require staff auth + `X-Business-Id` like every other business-
scoped route; routes under `/api/v1/loyalty/me/*` require customer auth
instead and never take `X-Business-Id` — a customer's own identity already
scopes which accounts they can see.

**Platform Admin Console** — routes under `/api/v1/platform/*` use the same
staff `Authorization` header as everything else, but authorize against
`users.platformRole` (`support`/`billing`/`admin`) instead of `X-Business-Id`
+ business permissions. Most staff accounts have no platform role at all
(`platformRole: null`) and get a `403 PLATFORM_ACCESS_DENIED` from every
route in this section. See the dedicated Platform Admin Console section
below for the full authorization model.

## Error Codes

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request body failed schema validation; `details` holds the Zod issue list |
| `MISSING_BUSINESS_CONTEXT` | 400 | `X-Business-Id` header not supplied on a route that requires it |
| `UNAUTHENTICATED` | 401 | Missing/malformed `Authorization` header, or an invalid/expired access token |
| `INVALID_CREDENTIALS` | 401 | Login: no such account, or wrong password (deliberately identical — see below) |
| `ACCOUNT_INACTIVE` | 401 | Login: credentials correct, but the account's `status` is not `active` |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh/logout: token unknown, expired, already revoked, or malformed |
| `NOT_A_MEMBER` | 403 | Authenticated, but no active role grant at the business in `X-Business-Id` |
| `PERMISSION_DENIED` | 403 | Member, but lacks the specific permission the route requires; `details.requiredPermission` names it |
| `SLUG_TAKEN` | 409 | `POST /businesses` or `POST /branches`: the requested slug is already in use (business-wide for businesses, per-business for branches) |
| `EMAIL_TAKEN` | 409 | `POST /auth/signup`: an account with that email already exists |
| `BRANCH_NOT_FOUND` | 404 | The branch doesn't exist, is soft-deleted, or belongs to a different business than `X-Business-Id` |
| `QR_CODE_NOT_FOUND` | 404 | The token doesn't match any active QR code — identical for an unknown token and a revoked one (enumeration resistance, same principle as `INVALID_CREDENTIALS`) |
| `FEEDBACK_NOT_FOUND` | 404 | The feedback id doesn't exist, is soft-deleted, or belongs to a different business than `X-Business-Id` |
| `BUSINESS_NOT_FOUND` | 404 | `GET /businesses/:id/public`, or any `GET`/`PATCH /platform/businesses/:id*` route: no business with that id |
| `OTP_COOLDOWN` | 429 | `POST /customer-auth/otp/request`: a code was already requested for this phone within the last 60 seconds |
| `OTP_INVALID` | 401 | `POST /customer-auth/otp/verify`: the code is wrong, expired, or there is no outstanding code for this phone — deliberately identical for all three (enumeration resistance) |
| `OTP_MAX_ATTEMPTS` | 429 | `POST /customer-auth/otp/verify`: the outstanding code has already been guessed wrong 5 times; the correct code no longer works either — request a new one |
| `CUSTOMER_SUSPENDED` | 401 | `POST /customer-auth/otp/verify`: the code was correct, but this customer's account `status` is not `active` |
| `LOYALTY_ACCOUNT_NOT_FOUND` | 404 | The loyalty account doesn't exist, or belongs to a different business/customer than the caller |
| `LOYALTY_TIER_NOT_FOUND` | 404 | The tier doesn't exist or belongs to a different business |
| `LOYALTY_REWARD_NOT_FOUND` | 404 | The reward doesn't exist, is inactive, or belongs to a different business |
| `INSUFFICIENT_POINTS` | 422 | A points-adjustment or redemption would drop (or already leaves) the account balance below zero |
| `REDEMPTION_NOT_FOUND` | 404 | The redemption code doesn't exist, or exists but belongs to a different business than `X-Business-Id` — same 404 either way, so a lookup can never confirm a code is valid *somewhere else* |
| `REDEMPTION_ALREADY_CONFIRMED` | 409 | `POST /loyalty/redemptions/:code/confirm`: this code was already confirmed once — confirmation is one-way |
| `REDEMPTION_CODE_EXHAUSTED` | 500 | Extremely unlikely: 5 consecutive redemption-code collisions against the 32^8 alphabet |
| `INVALID_DATE_RANGE` | 400 | Analytics: `from`/`to` fails to parse as a date, or `from` is after `to`. Also `GET /platform/audit-log` (same validation, different route) |
| `DATE_RANGE_TOO_LARGE` | 400 | Analytics: the resolved `from`..`to` span exceeds 366 days |
| `PLATFORM_ACCESS_DENIED` | 403 | Platform Admin Console: the caller's `users.platformRole` is `null` — not a platform admin at all |
| `PLATFORM_ROLE_DENIED` | 403 | Platform Admin Console: the caller has a `platformRole`, but not one the route's allow-list admits; `details.requiredRoles`/`details.actualRole` name both |
| `INVALID_STATUS_FILTER` | 400 | `GET /platform/businesses` or `GET /platform/billing/subscriptions`: the `status` query param isn't one of the valid enum values |
| `USER_NOT_FOUND` | 404 | Impersonation: the target `userId` doesn't exist. Also `POST /billing/checkout`: the caller's own user row wasn't found (should not happen for a validly authenticated request) |
| `USER_NOT_ACTIVE` | 409 | `POST /platform/businesses/:id/impersonate`: the target user's `status` is not `active` |
| `USER_NOT_A_MEMBER` | 409 | `POST /platform/businesses/:id/impersonate`: the target user has no active role grant at the named business |
| `PLAN_NOT_FOUND` | 404 | `POST /billing/checkout`: the plan doesn't exist or is retired. Also `PATCH /platform/billing/plans/:id`: no plan with that id |
| `PLAN_NOT_PURCHASABLE` | 422 | `POST /billing/checkout`: the plan has no Stripe price configured for the requested interval |
| `PLAN_KEY_TAKEN` | 409 | `POST /platform/billing/plans`: a plan with that `key` already exists |
| `STRIPE_SESSION_ERROR` | 500 | `POST /billing/checkout`: Stripe did not return a checkout URL |
| `NO_STRIPE_CUSTOMER` | 422 | `POST /billing/portal`: this business has no Stripe customer yet (still on a card-less trial) |
| `MISSING_SIGNATURE` | 400 | `POST /webhooks/stripe`: no `Stripe-Signature` header on the request |
| `INVALID_SIGNATURE` | 400 | `POST /webhooks/stripe`: signature verification failed — never retried by Stripe |
| `RATE_LIMITED` | 429 | Too many requests from this IP against the matched limiter |
| `INTERNAL_ERROR` | 500 | Unexpected server error; no internal detail is included |

`INVALID_CREDENTIALS` intentionally does not distinguish "account doesn't
exist" from "password is wrong" — returning different errors would let an
attacker enumerate registered emails.

## Endpoints

### `GET /health`

Infrastructure probe. Unversioned, unauthenticated, outside all middleware
(CORS/rate-limit/security-headers) — intended for load balancers and uptime
monitors, not application use.

**Response `200`**

```json
{ "status": "ok", "service": "echo-grid-feedback-api", "environment": "development", "timestamp": "2026-07-08T00:00:00.000Z" }
```

---

### `POST /api/v1/auth/signup`

Creates a user account and returns an authenticated token pair. No
`X-Business-Id` — account creation is a platform-level action, not scoped to a
tenant. Auth-tier rate limit applies.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `email` | string | valid email, trimmed, lowercased |
| `password` | string | min 12 characters |
| `fullName` | string | 1-200 characters, trimmed |

**Response `201`**

```json
{ "success": true, "data": { "accessToken": "...", "refreshToken": "..." } }
```

**Errors**: `VALIDATION_ERROR` (400), `EMAIL_TAKEN` (409), `RATE_LIMITED` (429).

---

### `POST /api/v1/auth/login`

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `email` | string | valid email |
| `password` | string | non-empty |

**Response `200`**

```json
{ "success": true, "data": { "accessToken": "...", "refreshToken": "..." } }
```

**Errors**: `VALIDATION_ERROR` (400), `INVALID_CREDENTIALS` (401),
`ACCOUNT_INACTIVE` (401), `RATE_LIMITED` (429).

---

### `POST /api/v1/auth/refresh`

Rotates a refresh token: the token supplied is revoked and a new access +
refresh pair is issued. Not rate-limited at the auth tier (only the API-wide
300/min floor applies) since it requires possessing a valid token already.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `refreshToken` | string | non-empty |

**Response `200`**

```json
{ "success": true, "data": { "accessToken": "...", "refreshToken": "..." } }
```

**Errors**: `VALIDATION_ERROR` (400), `INVALID_REFRESH_TOKEN` (401) — also
returned if the token was already rotated or revoked, which is how reuse of a
stolen token is caught.

---

### `POST /api/v1/auth/logout`

Revokes a refresh token. Idempotent — an already-invalid token is treated as
"already logged out," not an error.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `refreshToken` | string | non-empty |

**Response**: `204 No Content`, empty body.

---

### `GET /api/v1/auth/me`

Returns the authenticated user's own identity, including `platformRole` if
they have one (Platform Admin Console). Any authenticated user can call this
— `platformRole` is simply `null` for the overwhelming majority. Backs the
Platform Admin Console's own access guard and the dashboard's
impersonation-awareness banner.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "email": "owner@acme.test",
    "fullName": "Ada Owner",
    "platformRole": null,
    "impersonatedBy": null
  }
}
```

`impersonatedBy` is the platform admin's own `userId`, present only when the
calling token was minted by `POST /platform/businesses/:id/impersonate`.

**Errors**: `UNAUTHENTICATED` (401), `USER_NOT_FOUND` (404).

---

### `POST /api/v1/businesses`

Creates a business, seeds its four starter roles (Owner/Admin/Manager/Staff),
and grants the caller Owner — all in one transaction. Requires authentication
only (`authenticate`), not tenant context — this *is* the bootstrapping act,
not an action taken within an existing tenant.

**Headers**: `Authorization` required. `X-Business-Id` not applicable.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `name` | string | 1-200 characters, trimmed |
| `slug` | string | 2-60 chars, lowercase letters/numbers/hyphens only, trimmed |

**Response `201`**

```json
{ "success": true, "data": { "businessId": "uuid", "ownerRoleId": "uuid" } }
```

**Errors**: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `SLUG_TAKEN` (409).

**Audit**: records `business.created` with `{ name, slug }` in `metadata`.

---

### `GET /api/v1/businesses`

Lists the businesses the caller holds at least one active role grant in
(deduped across separate per-branch grants at the same business). Requires
authentication only, not tenant context — discovery of *which* businesses
you belong to necessarily comes before resolving context *within* one.
Added in Branch Mgmt Block 4 to power the web app's dashboard, which had no
way to answer "which businesses does this user belong to" before it.

**Headers**: `Authorization` required. `X-Business-Id` not applicable.

**Response `200`**

```json
{
  "success": true,
  "data": [
    { "id": "uuid", "name": "Acme Coffee", "slug": "acme-coffee", "status": "active", "...": "full business row" }
  ]
}
```

Returns full repository rows (not a trimmed DTO) — consistent with every
other list endpoint in this API; callers read only the fields they need.

**Errors**: `UNAUTHENTICATED` (401).

---

### `GET /api/v1/businesses/me`

Returns the caller's effective permissions at the business named in
`X-Business-Id` — the endpoint a frontend calls to answer "what can I do here."

**Headers**: `Authorization` + `X-Business-Id` required, `X-Branch-Id` optional.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "businessId": "uuid",
    "branchId": null,
    "permissions": ["business:view", "team:invite", "..."]
  }
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403).

---

### `PATCH /api/v1/businesses/me`

Updates the active business's profile/locale settings. `/me`, not `/:id` —
matches `GET /businesses/me`'s existing precedent; `X-Business-Id` already
disambiguates which business, so an id in the path would be redundant.
Requires `business:manage_settings` (reused, not a new permission).

**Headers**: `Authorization` + `X-Business-Id` required.

**Request body** — any subset (i18n & Multi-Currency module):

| Field | Type | Constraints |
| --- | --- | --- |
| `name` | string | optional, 1-200 characters, trimmed |
| `defaultLocale` | string | optional, one of `"en"` \| `"es"` \| `"fr"` — see [ARCHITECTURE.md](./ARCHITECTURE.md#risks--known-gaps) for why this is a closed enum, not open BCP-47 |
| `defaultCurrency` | string | optional, ISO 4217 code (regex-validated, not enum-restricted) |
| `defaultTimezone` | string | optional, IANA timezone (regex/length-validated, not enum-restricted) |

**Response `200`**: the updated business (same shape as `GET /businesses`' list response).

**Errors**: `VALIDATION_ERROR` (400 — includes an invalid `defaultLocale`,
since it fails `localeSchema` before the request ever reaches the database's
own CHECK constraint), `MISSING_BUSINESS_CONTEXT` (400), `UNAUTHENTICATED`
(401), `NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403).

**Audit**: records `business.updated` with `{ fields: [...patched field names] }`.

---

### `GET /api/v1/businesses/audit-log`

Returns this business's audit trail, newest first. Requires the `audit:view`
permission (granted to Owner/Admin by default).

**Headers**: `Authorization` + `X-Business-Id` required.

**Query params**: `limit`, `offset` (both optional integers).

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "businessId": "uuid",
      "actorUserId": "uuid",
      "action": "business.created",
      "entityType": "business",
      "entityId": "uuid",
      "metadata": { "name": "Acme Coffee", "slug": "acme-coffee" },
      "ipAddress": "203.0.113.4",
      "userAgent": "Mozilla/5.0...",
      "createdAt": "2026-07-08T00:00:00.000Z"
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403, `details.requiredPermission: "audit:view"`).

---

### `GET /api/v1/branches`

Lists branches at the business in `X-Business-Id`. Requires `branches:view`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Query params**: `limit`, `offset` (both optional integers).

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "businessId": "uuid", "name": "Downtown", "slug": "downtown",
      "addressLine1": "123 Main St", "addressLine2": null, "city": "Austin",
      "stateProvince": "TX", "postalCode": "78701", "countryCode": "US",
      "timezone": "America/Chicago", "latitude": null, "longitude": null,
      "status": "active", "createdAt": "2026-07-08T00:00:00.000Z", "updatedAt": "2026-07-08T00:00:00.000Z"
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403).

---

### `POST /api/v1/branches`

Creates a branch at the business in `X-Business-Id`. Requires `branches:manage`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Request body** — see [shared-types/branches.ts](../packages/shared-types/src/branches.ts)'s
`createBranchSchema`, also the contract `apps/web`'s branch form validates against client-side.

| Field | Type | Constraints |
| --- | --- | --- |
| `name` | string | 1-200 characters, trimmed |
| `slug` | string | 2-60 chars, lowercase letters/numbers/hyphens only |
| `addressLine1`, `addressLine2` | string | optional, max 200 chars |
| `city`, `stateProvince` | string | optional, max 100 chars |
| `postalCode` | string | optional, max 20 chars |
| `countryCode` | string | optional, exactly 2 chars, uppercased (ISO 3166-1 alpha-2) |
| `timezone` | string | optional, max 100 chars (IANA timezone) |
| `latitude` | number | optional, -90 to 90 |
| `longitude` | number | optional, -180 to 180 |

**Response `201`**: the created branch (same shape as the list response above).

**Errors**: `VALIDATION_ERROR` (400), `MISSING_BUSINESS_CONTEXT` (400),
`UNAUTHENTICATED` (401), `NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403),
`SLUG_TAKEN` (409) — scoped to this business only; the same slug is free to
use at a different business.

**Audit**: records `branch.created` with `{ name, slug }` in `metadata`.

---

### `GET /api/v1/branches/:id`

Returns one branch. Requires `branches:view`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Response `200`**: the branch (same shape as the list response above).

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `BRANCH_NOT_FOUND` (404) —
also returned (not a 403) if the id belongs to a *different* business than
`X-Business-Id`, so a lookup can never confirm a branch's existence across a
tenant boundary.

---

### `PATCH /api/v1/branches/:id`

Partially updates a branch. Requires `branches:manage`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Request body**: any subset of `POST /branches`'s fields (all optional here
too — see `updateBranchSchema`, `createBranchSchema.partial()`).

**Response `200`**: the updated branch.

**Errors**: `VALIDATION_ERROR` (400), `MISSING_BUSINESS_CONTEXT` (400),
`UNAUTHENTICATED` (401), `NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403),
`BRANCH_NOT_FOUND` (404) — checked *before* the slug-conflict check, so a
404 always wins over a 409 when both would otherwise apply — `SLUG_TAKEN`
(409, only if the new slug collides with a *different* branch; keeping a
branch's own existing slug in the patch is always allowed).

**Audit**: records `branch.updated` with `{ fields: [...patched field names] }`.

---

### `DELETE /api/v1/branches/:id`

Soft-deletes a branch. Requires `branches:manage`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Response**: `204 No Content`, empty body — note this route does *not*
return the standard `{success,data}` envelope; a client checking `body.success`
on a 204 will find no body to parse at all, not `false`.

**Errors**: `MISSING_BUSINESS_CONTEXT` (400), `UNAUTHENTICATED` (401),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `BRANCH_NOT_FOUND` (404) —
checked first, so deleting an unknown id 404s rather than silently
succeeding with no matching row.

**Audit**: records `branch.deleted`.

---

### `GET /api/v1/branches/:id/qr-code`

Returns the branch's active QR code, creating one on first call (lazy
get-or-create — a branch has no code until someone asks for it). Requires
`branches:view`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Response `200`**

```json
{ "success": true, "data": { "id": "uuid", "token": "a1b2c3d4e5f6g7h8i9j0", "status": "active" } }
```

No full scannable URL in the response on purpose — building
`https://<web-app-domain>/feedback/<token>` is a frontend concern (`apps/web`
already knows its own origin); the API has no reason to know its own
frontend's deployed domain.

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `BRANCH_NOT_FOUND` (404).

---

### `POST /api/v1/branches/:id/qr-code/regenerate`

Revokes the branch's current active QR code and issues a new one with a
different token. The old token stops resolving immediately — any printed
copies of it need replacing. Requires `branches:manage`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Response `200`**: the new code (same shape as `GET .../qr-code`).

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `BRANCH_NOT_FOUND` (404).

**Audit**: records `qr_code.regenerated` with `{ branchId }` in `metadata`.

---

### `GET /api/v1/qr/:token`

**Fully public — no `Authorization` header, no tenant headers.** The
platform's only anonymous-write-adjacent read: resolves a scanned QR token
to the branch/business display info the public landing page needs to render
itself. Subject to the `PUBLIC_RATE_LIMITER` (20/min/IP) in addition to the
general one.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "branchId": "uuid", "branchName": "Downtown", "businessName": "Acme Coffee",
    "defaultLocale": "en", "defaultCurrency": "USD", "defaultTimezone": "America/Chicago"
  }
}
```

The token itself is not echoed back — the caller already has it from the URL.
`defaultLocale`/`defaultCurrency`/`defaultTimezone` (i18n & Multi-Currency
module) were added to this response for free — the handler already loads
the full business row for `businessName` — and are what let the anonymous
feedback and check-in landing pages render in the scanned business's own
locale despite having no session at all.

**Errors**: `QR_CODE_NOT_FOUND` (404) — identical for an unknown or revoked
token, `RATE_LIMITED` (429).

---

### `POST /api/v1/qr/:token/feedback`

**Fully public.** The actual anonymous submission endpoint — a customer
scans a branch's QR code, lands on `apps/web`'s `/feedback/:token` page, and
this is what its form submits to (server-to-server from a Next.js Server
Action, never called directly by a browser under the BFF pattern). Subject
to `PUBLIC_RATE_LIMITER` (20/min/IP).

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `rating` | integer | 1-5, required |
| `comment` | string | optional, max 2000 chars |
| `customerName` | string | optional, max 200 chars |
| `customerEmail` | string | optional, valid email, max 320 chars |
| `customerPhone` | string | optional, max 30 chars |

Every field but `rating` is optional on purpose — a contact-info wall in
front of a star tap would defeat the point of a frictionless QR flow.

**Response `201`**

```json
{ "success": true, "data": { "id": "uuid" } }
```

**Errors**: `VALIDATION_ERROR` (400), `QR_CODE_NOT_FOUND` (404), `RATE_LIMITED` (429).

---

### `GET /api/v1/feedback`

Lists feedback submitted at the business in `X-Business-Id`, newest first.
Requires `feedback:view`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Query params**: `branchId` (optional, filters to one branch), `limit`,
`offset` (both optional integers).

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "businessId": "uuid", "branchId": "uuid", "qrCodeId": "uuid",
      "rating": 5, "comment": "Great service!", "customerName": null,
      "customerEmail": null, "customerPhone": null, "status": "new",
      "createdAt": "2026-07-08T00:00:00.000Z"
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403).

---

### `PATCH /api/v1/feedback/:id`

Marks a feedback item reviewed. Requires `feedback:manage`. Deliberately
narrow — the only accepted body is `{"status": "reviewed"}`; there is no
route back to `"new"`, and no way to edit a customer's actual rating or
comment through this or any endpoint.

**Headers**: `Authorization` + `X-Business-Id` required.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `status` | string | must be exactly `"reviewed"` |

**Response `200`**: the updated feedback row (same shape as the list response above).

**Errors**: `VALIDATION_ERROR` (400), `MISSING_BUSINESS_CONTEXT` (400),
`UNAUTHENTICATED` (401), `NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403),
`FEEDBACK_NOT_FOUND` (404).

**Audit**: records `feedback.reviewed`.

---

### `DELETE /api/v1/feedback/:id`

Soft-deletes a feedback item (e.g. spam/abusive submissions). Requires
`feedback:manage`.

**Headers**: `Authorization` + `X-Business-Id` required.

**Response**: `204 No Content`, empty body.

**Errors**: `MISSING_BUSINESS_CONTEXT` (400), `UNAUTHENTICATED` (401),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `FEEDBACK_NOT_FOUND` (404).

**Audit**: records `feedback.removed`.

---

### `POST /api/v1/feedback/:id/reanalyze`

Manually re-queues sentiment classification for one feedback row — for a row
stuck at `analysisStatus: 'failed'`, or to re-run a `'completed'` one after a
classifier change. Requires `feedback:manage` (not a new permission):
triaging a submission's analysis state is the same supervisory action as
marking it reviewed, not a distinct capability. Returns as soon as the job
is enqueued, not once classification completes.

**Headers**: `Authorization` + `X-Business-Id` required.

**Response `202`**

```json
{ "success": true, "data": { "id": "uuid", "analysisStatus": "failed" } }
```

`analysisStatus` reflects the row's state *before* re-queuing, not the
result — the classification itself runs asynchronously in the `JOBS` queue
consumer, same as the original submission-time classification.

**Errors**: `MISSING_BUSINESS_CONTEXT` (400), `UNAUTHENTICATED` (401),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `FEEDBACK_NOT_FOUND` (404).

---

### `GET /api/v1/businesses/:id/public`

**Fully public.** Name-only lookup so a customer-facing page (no staff
session) can display which business a loyalty account belongs to. Subject to
`PUBLIC_RATE_LIMITER`. Widened in the i18n & Multi-Currency module with the
3 locale/currency/timezone fields, free — the handler already loads the full
business row — so the customer loyalty dashboard (`[businessId]/layout.tsx`)
can render in the business's own locale with no session of its own.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "uuid", "name": "Acme Coffee",
    "defaultLocale": "en", "defaultCurrency": "USD", "defaultTimezone": "America/Chicago"
  }
}
```

**Errors**: `BUSINESS_NOT_FOUND` (404), `RATE_LIMITED` (429).

---

### `POST /api/v1/customer-auth/otp/request`

**Fully public.** Step 1 of customer sign-in: sends a 6-digit SMS code to the
given phone. Always returns `204` regardless of whether the phone belongs to
an existing customer — no signal either way (enumeration resistance). In
non-production environments the code is logged to the API server's console
instead of a real SMS (`ConsoleSmsService`). Subject to the strict
`OTP_RATE_LIMITER` (3/min/IP).

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `phone` | string | E.164 format, e.g. `+15551234567` |

**Response**: `204 No Content`.

**Errors**: `VALIDATION_ERROR` (400), `OTP_COOLDOWN` (429, a code was already
sent to this phone in the last 60 seconds), `RATE_LIMITED` (429).

---

### `POST /api/v1/customer-auth/otp/verify`

**Fully public.** Step 2: verifies the code and issues a customer session.
Creates the `customers` row on first-ever successful verify for a phone.
Subject to `OTP_RATE_LIMITER`.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `phone` | string | E.164 format |
| `code` | string | exactly 6 digits |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "accessToken": "...",
    "customer": {
      "id": "uuid", "phone": "+15551234567", "fullName": null, "email": null,
      "birthday": null, "phoneVerifiedAt": "2026-07-08T00:00:00.000Z",
      "status": "active", "createdAt": "2026-07-08T00:00:00.000Z"
    }
  }
}
```

`accessToken` is a single, non-rotating, 90-day customer JWT — no refresh
token exists for this identity system (see ARCHITECTURE.md's Security
Architecture for why this is a deliberate scope reduction versus staff auth).

**Errors**: `VALIDATION_ERROR` (400), `OTP_INVALID` (401), `OTP_MAX_ATTEMPTS`
(429), `CUSTOMER_SUSPENDED` (401), `RATE_LIMITED` (429).

---

### `GET /api/v1/loyalty/accounts`

Lists loyalty accounts at the business in `X-Business-Id`, newest-visit-first,
joined with each customer's phone/name so the staff list is human-readable.
Requires `loyalty:view`.

**Headers**: `Authorization` (staff) + `X-Business-Id` required.

**Query params**: `limit`, `offset`.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "customerId": "uuid", "businessId": "uuid", "points": 240,
      "tierId": "uuid", "visitCount": 6, "lastVisitAt": "2026-07-08T00:00:00.000Z",
      "status": "active", "customer": { "id": "uuid", "phone": "+15551234567", "fullName": null }
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403).

---

### `GET /api/v1/loyalty/accounts/:id`

Returns one account. Requires `loyalty:view`.

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `LOYALTY_ACCOUNT_NOT_FOUND` (404).

---

### `GET /api/v1/loyalty/accounts/:id/transactions`

Returns the account's ledger, newest first. Requires `loyalty:view`.

**Query params**: `limit`, `offset`.

**Errors**: same as `GET /loyalty/accounts/:id`.

---

### `POST /api/v1/loyalty/accounts/:id/purchase`

Staff records a purchase at the counter; points earned = `floor(purchaseAmount
* pointsPerCurrencyUnit)` using the business's current settings. Requires
`loyalty:manage`.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `purchaseAmount` | number | positive, max 1,000,000 |

**Response `200`**: the updated account (same shape as the list response above).

**Errors**: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`MISSING_BUSINESS_CONTEXT` (400), `NOT_A_MEMBER` (403), `PERMISSION_DENIED`
(403), `LOYALTY_ACCOUNT_NOT_FOUND` (404).

**Audit**: records `loyalty.purchase_recorded`.

---

### `POST /api/v1/loyalty/accounts/:id/adjust`

Manual staff correction to a balance — positive or negative. Rejected if it
would drop the balance below zero. Requires `loyalty:manage`.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `points` | integer | nonzero |
| `notes` | string | optional, max 500 chars |

**Response `200`**: the updated account.

**Errors**: `VALIDATION_ERROR` (400), `INSUFFICIENT_POINTS` (422), plus the
usual auth/tenant errors, `LOYALTY_ACCOUNT_NOT_FOUND` (404).

**Audit**: records `loyalty.points_adjusted`.

---

### `GET /api/v1/loyalty/settings` · `PATCH /api/v1/loyalty/settings`

Per-business earning-rate configuration (points per check-in, points per
currency unit, referral/birthday bonus amounts). Lazily created with sensible
defaults on first read — every business has a row, even one that predates
this table. `GET` requires `loyalty:view`; `PATCH` requires `rewards:manage`
(program *design*, not day-to-day operation — the same split that separates
Staff's `loyalty:manage` from `rewards:manage`).

**`PATCH` request body** — any subset:

| Field | Type | Constraints |
| --- | --- | --- |
| `pointsPerCheckin` | integer | >= 0 |
| `pointsPerCurrencyUnit` | number | >= 0 |
| `referralBonusPoints` | integer | >= 0 |
| `birthdayBonusPoints` | integer | >= 0 |

**Response `200`**

```json
{
  "success": true,
  "data": {
    "businessId": "uuid", "pointsPerCheckin": 10, "pointsPerCurrencyUnit": 1,
    "referralBonusPoints": 50, "birthdayBonusPoints": 100
  }
}
```

**Errors**: usual auth/tenant errors, `VALIDATION_ERROR` (400, `PATCH` only),
`PERMISSION_DENIED` (403).

**Audit** (`PATCH` only): records `loyalty.settings_updated`.

---

### `GET /api/v1/loyalty/tiers` · `POST` · `PATCH /:id` · `DELETE /:id`

Tier CRUD (Silver/Gold/etc, each with a `minPoints` threshold, `benefits`
free text, and a `sortOrder`). `GET` requires `loyalty:view`; the three
mutating routes require `rewards:manage`.

**`POST`/`PATCH` request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `name` | string | 1-100 chars |
| `minPoints` | integer | >= 0 |
| `benefits` | string | optional, max 1000 chars |
| `sortOrder` | integer | optional, >= 0 |

**Response**: `POST` → `201` with the created tier; `PATCH` → `200` with the
updated tier; `DELETE` → `204 No Content`; `GET` → `200` with the array.

**Errors**: usual auth/tenant errors, `VALIDATION_ERROR` (400, write routes),
`LOYALTY_TIER_NOT_FOUND` (404, `PATCH`/`DELETE`).

**Audit**: `loyalty.tier_created` / `loyalty.tier_updated` / `loyalty.tier_removed`.

---

### `GET /api/v1/loyalty/rewards` · `POST` · `PATCH /:id` · `DELETE /:id`

Reward-catalog CRUD. Staff's `GET` always includes inactive/retired rewards
(`includeInactive: true` internally) — the customer-facing catalog
(`GET /loyalty/me/rewards/:businessId`) is what filters to active-only.
`GET` requires `loyalty:view`; the three mutating routes require `rewards:manage`.

**`POST`/`PATCH` request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `name` | string | 1-100 chars |
| `description` | string | optional, max 1000 chars |
| `pointsCost` | integer | positive |
| `status` | string | `PATCH` only: `"active"` \| `"inactive"` |

**Response**: same status-code shape as tiers above.

**Errors**: usual auth/tenant errors, `VALIDATION_ERROR` (400, write routes),
`LOYALTY_REWARD_NOT_FOUND` (404, `PATCH`/`DELETE`).

**Audit**: `loyalty.reward_created` / `loyalty.reward_updated` / `loyalty.reward_removed`.

---

### `GET /api/v1/loyalty/redemptions/:code`

Staff counter lookup: what does this redemption code correspond to (which
reward, how many points, already confirmed or not). Requires `loyalty:view`.

**Response `200`**: the `loyalty_transactions` row for the redemption.

**Errors**: usual auth/tenant errors, `REDEMPTION_NOT_FOUND` (404) — identical
whether the code never existed or belongs to a *different* business, so a
lookup can never confirm a code is valid elsewhere.

---

### `POST /api/v1/loyalty/redemptions/:code/confirm`

Staff confirms they've physically handed over the reward. One-way — a second
confirm attempt on the same code is rejected. Requires `loyalty:manage`.

**Response `200`**: the updated (now-confirmed) transaction row.

**Errors**: usual auth/tenant errors, `REDEMPTION_NOT_FOUND` (404),
`REDEMPTION_ALREADY_CONFIRMED` (409).

**Audit**: records `loyalty.redemption_confirmed`.

---

### `GET /api/v1/loyalty/me/accounts`

**Customer-authenticated** (`Authorization` = customer JWT; no
`X-Business-Id`). Every loyalty account the calling customer belongs to,
across every business — their "my loyalty cards" list.

**Response `200`**: array of accounts (same shape as the staff list, minus
the `customer` join — the caller already knows who they are).

**Errors**: `UNAUTHENTICATED` (401), `RATE_LIMITED` (429).

---

### `GET /api/v1/loyalty/me/accounts/:businessId`

One business's account summary for the calling customer: the account plus
its 20 most recent ledger transactions.

**Response `200`**

```json
{ "success": true, "data": { "account": { "...": "LoyaltyAccountDto" }, "recentTransactions": [ ] } }
```

**Errors**: `UNAUTHENTICATED` (401), `LOYALTY_ACCOUNT_NOT_FOUND` (404, not
enrolled at this business), `RATE_LIMITED` (429).

---

### `POST /api/v1/loyalty/me/join`

Explicit "join this business's loyalty program" — idempotent, returns the
existing account if already enrolled. Distinct from `POST .../checkin`'s
auto-enroll, for a customer joining without having scanned a QR code (e.g. a
referral link).

**Request body**: `{ "businessId": "uuid" }`.

**Response `201`**: the account.

**Errors**: `UNAUTHENTICATED` (401), `VALIDATION_ERROR` (400), `RATE_LIMITED` (429).

---

### `POST /api/v1/loyalty/me/checkin`

Scans the same anonymous QR token `GET /qr/:token`/feedback submission uses.
Auto-enrolls the customer if this is their first visit to this business, then
awards `pointsPerCheckin` and bumps `visitCount`/`lastVisitAt`.

**Request body**: `{ "qrToken": "..." }`.

**Response `200`**: the updated account.

**Errors**: `UNAUTHENTICATED` (401), `VALIDATION_ERROR` (400),
`QR_CODE_NOT_FOUND` (404), `RATE_LIMITED` (429).

---

### `GET /api/v1/loyalty/me/tiers/:businessId`

The full tier ladder for a business (not just the customer's current tier) —
needed to render "N points to Gold" progress. No permission gate beyond
customer auth: any customer viewing their own account should see the ladder
they're progressing through.

**Response `200`**: array of tiers (same shape as the staff `GET /loyalty/tiers`).

**Errors**: `UNAUTHENTICATED` (401), `RATE_LIMITED` (429).

---

### `GET /api/v1/loyalty/me/rewards/:businessId`

The active-only reward catalog for a business.

**Response `200`**: array of rewards, `status: "active"` only.

**Errors**: `UNAUTHENTICATED` (401), `RATE_LIMITED` (429).

---

### `POST /api/v1/loyalty/me/accounts/:businessId/redeem`

Spends points for a reward and returns a redemption code the customer shows
staff at the counter. Does **not** hand over the reward itself — that's
`POST /loyalty/redemptions/:code/confirm`, a separate staff-side action, by
design (a customer redeeming does not mean staff has yet verified and handed
over the physical item).

**Request body**: `{ "rewardId": "uuid" }`.

**Response `201`**

```json
{ "success": true, "data": { "redemptionCode": "AB3XK9QZ", "pointsSpent": 100, "remainingBalance": 140 } }
```

**Errors**: `UNAUTHENTICATED` (401), `VALIDATION_ERROR` (400),
`LOYALTY_ACCOUNT_NOT_FOUND` (404), `LOYALTY_REWARD_NOT_FOUND` (404, includes
a retired/inactive reward), `INSUFFICIENT_POINTS` (422),
`REDEMPTION_CODE_EXHAUSTED` (500, effectively unreachable), `RATE_LIMITED` (429).

### `GET /api/v1/analytics/trends`

Day-bucketed sentiment counts for the trend chart, oldest bucket first.
Requires `analytics:view`. Empty days are not omitted — the frontend chart
expects one point per calendar day in range.

**Headers**: `Authorization` + `X-Business-Id` required.

**Query params**: `branchId` (optional, falls back to `X-Branch-Id`), `from`,
`to` (optional ISO date/datetime strings; default to the last 30 days —
see [ARCHITECTURE.md](./ARCHITECTURE.md) for the capping rationale).

**Response `200`**

```json
{
  "success": true,
  "data": [
    { "bucket": "2026-07-01", "positive": 12, "neutral": 3, "negative": 1 }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `INVALID_DATE_RANGE` (400),
`DATE_RANGE_TOO_LARGE` (400).

---

### `GET /api/v1/analytics/search`

Searchable, filterable feedback list — sentiment/rating/keyword/date-range,
paginated with the same limit+1 "Older/Newer" trick used by the feedback
inbox (no repository in this codebase exposes a total count). Requires
`analytics:view`. `keyword` matches `comment` only — `customerName`/
`customerEmail`/`customerPhone` are deliberately excluded from free-text
search so this endpoint can never become a PII lookup tool.

**Headers**: `Authorization` + `X-Business-Id` required.

**Query params**: `branchId`, `sentiment` (`positive`\|`neutral`\|`negative`),
`rating` (1-5), `keyword`, `from`, `to`, `limit`, `offset` — all optional.

**Response `200`**: array of feedback rows (same shape as `GET /feedback`,
plus `sentiment`, `sentimentScore`, `analysisStatus`, `analyzedAt`).

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403), `INVALID_DATE_RANGE` (400),
`DATE_RANGE_TOO_LARGE` (400).

---

### `GET /api/v1/analytics/summaries`

Lists AI-generated period summaries, most recent first. Requires
`analytics:view`. A `branchId`-omitted call returns business-wide summaries
only (`branchId: null` rows) — it does not mean "all branches combined";
business-wide and per-branch summaries are two distinct report types never
mixed in one response.

**Headers**: `Authorization` + `X-Business-Id` required.

**Query params**: `branchId`, `periodType` (`weekly`\|`monthly`), `limit`,
`offset` — all optional.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "businessId": "uuid", "branchId": null,
      "periodType": "weekly", "periodStart": "2026-07-01T00:00:00.000Z",
      "periodEnd": "2026-07-08T00:00:00.000Z", "feedbackCount": 42,
      "positiveCount": 30, "neutralCount": 8, "negativeCount": 4,
      "summary": "Overall sentiment was strongly positive...",
      "recommendations": "Consider extending weekend hours...",
      "createdAt": "2026-07-08T00:00:00.000Z"
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403).

---

### `POST /api/v1/analytics/summaries/generate`

Queues on-demand generation of a period summary via the `JOBS` queue —
returns as soon as the job is enqueued, not once it completes. Requires
`analytics:manage`, a stricter permission than `:view` since every
invocation costs a real Anthropic API call. Accepts only a canned
`periodType` (not an arbitrary date range) to keep the cost of a single
request bounded — see [ARCHITECTURE.md](./ARCHITECTURE.md)'s Risks section
for the no-polling caveat.

**Headers**: `Authorization` + `X-Business-Id` required.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `periodType` | string | `"weekly"` or `"monthly"` |
| `branchId` | string | optional UUID; omitted = business-wide summary |

**Response `202`**

```json
{ "success": true, "data": { "status": "queued", "periodType": "weekly" } }
```

**Errors**: `VALIDATION_ERROR` (400), `MISSING_BUSINESS_CONTEXT` (400),
`UNAUTHENTICATED` (401), `NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403).

**Audit**: records `analytics.summary_requested`.

---

### `GET /api/v1/notifications/preferences` · `PATCH /api/v1/notifications/preferences`

**Self-service, no permission gate** — any authenticated staff member with an
active grant at the business manages their own notification preferences,
same reasoning as a customer managing their own loyalty account needing no
special grant. Returns the *materialized* grid: every (eventType, channel)
combination for the 3 staff-facing event types (`feedback_received`,
`summary_ready`, `redemption_pending`) × 2 deliverable channels
(`email`, `sms` — `push` is a defined future channel with no delivery
implementation yet, so it never appears here), not just rows that happen to
exist — an absent row means `enabled: true` (the default; this module is
entirely transactional, not promotional, see ARCHITECTURE.md).

**Headers**: `Authorization` + `X-Business-Id` required.

**PATCH request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `preferences` | array | 1-50 items, each `{ eventType, channel, enabled }` |

**Response `200`** (`GET` and `PATCH` return the same shape)

```json
{
  "success": true,
  "data": [
    { "eventType": "feedback_received", "channel": "email", "enabled": true },
    { "eventType": "feedback_received", "channel": "sms", "enabled": true },
    { "eventType": "summary_ready", "channel": "email", "enabled": true },
    { "eventType": "summary_ready", "channel": "sms", "enabled": false },
    { "eventType": "redemption_pending", "channel": "email", "enabled": true },
    { "eventType": "redemption_pending", "channel": "sms", "enabled": true }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `VALIDATION_ERROR` (400, `PATCH` only).

No audit entry — self-service preference changes are not logged, consistent
with this platform's audit trail covering business-affecting actions, not a
member's own personal settings.

---

### `GET /api/v1/notifications/settings` · `PATCH /api/v1/notifications/settings`

Business-wide delivery configuration: email/SMS kill switches and the daily
SMS cost cap (`maxSmsPerDay`, default 50 — a real cost-abuse vector exists
because public unauthenticated feedback submission can trigger an SMS via
`feedback_received`). Lazily created with defaults on first read, same
get-or-create pattern as `GET /loyalty/settings`. `GET` requires
`notifications:view`; `PATCH` requires `notifications:manage`.

**Headers**: `Authorization` + `X-Business-Id` required.

**PATCH request body** — any subset:

| Field | Type | Constraints |
| --- | --- | --- |
| `emailEnabled` | boolean | optional |
| `smsEnabled` | boolean | optional |
| `maxSmsPerDay` | integer | optional, >= 0 |

**Response `200`**

```json
{ "success": true, "data": { "businessId": "uuid", "emailEnabled": true, "smsEnabled": true, "maxSmsPerDay": 50 } }
```

**Errors**: usual auth/tenant errors, `PERMISSION_DENIED` (403),
`VALIDATION_ERROR` (400, `PATCH` only).

**Audit** (`PATCH` only): records `notifications.settings_updated`.

---

### `GET /api/v1/notifications`

Send log — every notification attempt (`pending`/`sent`/`failed`), newest
first, for support/debugging. Requires `notifications:view` since entries
include the recipient's actual `recipientAddress` (email/phone snapshotted
at send time), not just aggregate counts.

**Headers**: `Authorization` + `X-Business-Id` required.

**Query params**: `limit`, `offset` (both optional integers).

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "businessId": "uuid", "userId": "uuid", "customerId": null,
      "eventType": "summary_ready", "channel": "email",
      "recipientAddress": "owner@example.com",
      "subject": "Your Acme Coffee feedback summary is ready", "status": "sent",
      "sentAt": "2026-07-10T00:00:00.000Z", "createdAt": "2026-07-10T00:00:00.000Z"
    }
  ]
}
```

**Errors**: usual auth/tenant errors, `PERMISSION_DENIED` (403).

---

### `GET /api/v1/loyalty/me/notification-preferences/:businessId` · `PATCH /api/v1/loyalty/me/notification-preferences/:businessId`

**Customer-authenticated**, self-service, same materialized-grid shape as
the staff preferences endpoint above but scoped to the 3 customer-facing
event types (`points_earned`, `tier_upgraded`, `reward_redeemed`).
`businessId` is a path param, not `X-Business-Id` — this mount has no
tenant-header concept, matching every other `/loyalty/me/*` route.
Deliberately **no enrollment check**: a preference row for a business the
customer hasn't joined is inert (nothing ever targets it — a customer only
ever reaches `NotificationService` from an actual loyalty event at a
business they belong to), so this endpoint stays as simple as the rest of
`/loyalty/me/*`'s identity-only scoping rather than re-deriving enrollment
state a second time.

**Response `200`** (`GET` and `PATCH` return the same shape)

```json
{
  "success": true,
  "data": [
    { "eventType": "points_earned", "channel": "email", "enabled": true },
    { "eventType": "points_earned", "channel": "sms", "enabled": true },
    { "eventType": "tier_upgraded", "channel": "email", "enabled": true },
    { "eventType": "tier_upgraded", "channel": "sms", "enabled": true },
    { "eventType": "reward_redeemed", "channel": "email", "enabled": true },
    { "eventType": "reward_redeemed", "channel": "sms", "enabled": true }
  ]
}
```

**PATCH request body**: same shape as the staff endpoint above.

**Errors**: `UNAUTHENTICATED` (401), `VALIDATION_ERROR` (400, `PATCH` only),
`RATE_LIMITED` (429).

---

## Platform Admin Console

Every route below requires `Authorization` plus a `platformRole` of
`support`, `billing`, or `admin` on the caller's own `users` row —
independent of, and in addition to, ordinary staff authentication. None of
these routes take `X-Business-Id`: they are cross-tenant by definition, so
tenant context has nothing to resolve. `requirePlatformRole` re-checks the
role directly against the database on every request (never trusted from the
JWT) and re-checks `status === 'active'` as defense in depth. `allowedRoles`
is an explicit allow-list per route, not a hierarchy — a route restricted to
`['billing']` does not admit `admin` unless it says so.

### `GET /api/v1/platform/businesses`

Cross-tenant business directory, searchable and filterable. Requires
`support`, `billing`, or `admin`.

**Query params**: `search` (matches name/slug), `status`
(`active`|`suspended`|`archived`), `limit`, `offset`.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "name": "Acme Coffee", "slug": "acme-coffee",
      "legalName": "Acme Coffee LLC", "industry": "Food & Beverage",
      "defaultLocale": "en", "defaultCurrency": "USD", "defaultTimezone": "America/Chicago",
      "status": "active", "createdAt": "2026-07-08T00:00:00.000Z"
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `PLATFORM_ACCESS_DENIED` (403, no
platform role at all), `PLATFORM_ROLE_DENIED` (403, has a role but not one
of the allowed ones), `INVALID_STATUS_FILTER` (400).

---

### `GET /api/v1/platform/businesses/:id`

One business, same shape as an entry above. Requires `support`, `billing`,
or `admin`.

**Errors**: `UNAUTHENTICATED` (401), `PLATFORM_ACCESS_DENIED` (403),
`PLATFORM_ROLE_DENIED` (403), `BUSINESS_NOT_FOUND` (404).

---

### `GET /api/v1/platform/businesses/:id/team`

This business's team, hydrated with user/role display fields — what the
impersonation target picker needs to show names instead of raw IDs. Requires
`support`, `billing`, or `admin`.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "userId": "uuid", "userEmail": "owner@acme.test",
      "userFullName": "Ada Owner", "roleId": "uuid", "roleName": "Owner",
      "branchId": null
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `PLATFORM_ACCESS_DENIED` (403),
`PLATFORM_ROLE_DENIED` (403), `BUSINESS_NOT_FOUND` (404).

---

### `PATCH /api/v1/platform/businesses/:id/status`

Suspends, reactivates, or archives a business. `admin`-only — `support`/
`billing` get read access above, not the ability to take a paying customer's
business offline.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `status` | string | one of `active`, `suspended`, `archived` |
| `reason` | string | optional, max 500 chars — not a column on `businesses`; carried into the audit entry's `metadata` only |

**Response `200`**: the updated business, same shape as `GET /platform/businesses/:id`.

**Errors**: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`PLATFORM_ACCESS_DENIED` (403), `PLATFORM_ROLE_DENIED` (403,
`details.requiredRoles: ["admin"]`), `BUSINESS_NOT_FOUND` (404).

**Audit**: records `business.status_changed_by_platform` with
`{ status, reason }`; `businessId` is set explicitly on the entry since
there's no tenant context here to infer it from.

---

### `POST /api/v1/platform/businesses/:id/impersonate`

Mints a short-lived (30 min), **non-renewable** access token letting the
caller see the product exactly as the named staff member would. `support`/
`admin` only — deliberately **not** `billing`.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `userId` | uuid | must hold an active role grant at this specific business |
| `reason` | string | required, 1-500 chars — carried into the audit entry |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJ...",
    "expiresAt": "2026-07-11T00:30:00.000Z",
    "targetUser": { "id": "uuid", "email": "staff@acme.test", "fullName": "Sam Staff" }
  }
}
```

No refresh token is issued — re-initiate through this same endpoint once the
30-minute window expires; each call re-validates the target's membership and
re-logs the action.

**Errors**: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`PLATFORM_ACCESS_DENIED` (403), `PLATFORM_ROLE_DENIED` (403),
`USER_NOT_FOUND` (404), `USER_NOT_ACTIVE` (409), `USER_NOT_A_MEMBER` (409,
the target has no active role grant at this business).

**Audit**: records `user.impersonation_started` with
`{ targetUserEmail, reason }`; `businessId` set explicitly.

---

### `GET /api/v1/platform/audit-log`

Platform-wide audit trail — every business's entries, filterable. The
cross-tenant counterpart to `GET /businesses/audit-log`, which stays scoped
to the caller's own tenant. Open to every platform role — cross-tenant
visibility for debugging is `support`'s whole purpose.

**Query params**: `businessId`, `actorUserId`, `entityType`, `action` (all
exact-match, optional), `from`/`to` (ISO 8601, optional), `limit`, `offset`.
All filters are ANDed; omitting all of them returns the full platform log.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "businessId": "uuid", "businessName": "Acme Coffee",
      "actorUserId": "uuid", "actorEmail": "owner@acme.test", "actorFullName": "Ada Owner",
      "action": "business.status_changed_by_platform", "entityType": "business", "entityId": "uuid",
      "metadata": { "status": "suspended", "reason": "non-payment" },
      "ipAddress": "203.0.113.4", "userAgent": "Mozilla/5.0...",
      "createdAt": "2026-07-11T00:00:00.000Z"
    }
  ]
}
```

`businessName`/`actorEmail`/`actorFullName` are independently nullable from
`businessId`/`actorUserId` — an entry can reference a business or user that
was since soft-deleted, or (system-attributed entries) have no actor at all.

**Errors**: `UNAUTHENTICATED` (401), `PLATFORM_ACCESS_DENIED` (403),
`PLATFORM_ROLE_DENIED` (403), `INVALID_DATE_RANGE` (400).

---

### `GET /api/v1/platform/billing/plans`

Full plan catalog, **including retired** (`isActive: false`) plans — a
platform admin managing the catalog needs to see and potentially reactivate
one. Requires `support`, `billing`, or `admin`. Unlike the business-facing
`GET /billing/plans` below, this includes Stripe price IDs.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "key": "growth", "name": "Growth", "description": "For growing teams.",
      "priceMonthlyCents": 9900, "priceYearlyCents": 99000, "currency": "usd",
      "stripePriceIdMonthly": "price_...", "stripePriceIdYearly": "price_...",
      "maxBranches": 5, "maxUsers": 20, "isActive": true, "isDefaultTrial": false,
      "sortOrder": 1, "createdAt": "2026-07-11T00:00:00.000Z"
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `PLATFORM_ACCESS_DENIED` (403),
`PLATFORM_ROLE_DENIED` (403).

---

### `POST /api/v1/platform/billing/plans`

Adds a plan to the catalog. `billing`/`admin` only — `support` does not get
catalog mutation.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `key` | string | 2-60 chars, lowercase letters/numbers/hyphens, **immutable after creation** |
| `name` | string | 1-200 chars |
| `description` | string | optional, max 1000 chars |
| `priceMonthlyCents` | integer | ≥ 0 |
| `priceYearlyCents` | integer | optional, ≥ 0 |
| `currency` | string | 3-letter lowercase ISO 4217, default `usd` |
| `stripePriceIdMonthly`, `stripePriceIdYearly` | string | optional |
| `maxBranches`, `maxUsers` | integer | optional, ≥ 0 — omit for unlimited |
| `isActive`, `isDefaultTrial` | boolean | optional |
| `sortOrder` | integer | optional |

**Response `201`**: the created plan, same shape as `GET /platform/billing/plans`'s entries.

**Errors**: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`PLATFORM_ACCESS_DENIED` (403), `PLATFORM_ROLE_DENIED` (403),
`PLAN_KEY_TAKEN` (409).

**Audit**: records `subscription_plan.created` with `{ key, name }`.

---

### `PATCH /api/v1/platform/billing/plans/:id`

Edits a plan. Same body as `POST` above, minus `key` (immutable), every
field optional. `billing`/`admin` only. Promoting `isDefaultTrial: true`
atomically demotes whichever plan currently holds it, in the same
transaction — at most one plan is ever the default trial platform-wide.

**Response `200`**: the updated plan.

**Errors**: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`PLATFORM_ACCESS_DENIED` (403), `PLATFORM_ROLE_DENIED` (403),
`PLAN_NOT_FOUND` (404).

**Audit**: records `subscription_plan.updated` with `{ fields: [...changed keys] }`.

---

### `GET /api/v1/platform/billing/subscriptions`

Cross-tenant subscription list, hydrated with business/plan names,
filterable by status, paginated. Requires `support`, `billing`, or `admin`.
No mutation route exists here on purpose — changing a specific business's
plan is a business-facing self-service action (or a support-driven one via
impersonation), not a bulk platform-admin edit surface.

**Query params**: `status` (one of the 7 Stripe-mirrored values below),
`limit`, `offset`.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "businessId": "uuid", "businessName": "Acme Coffee",
      "planId": "uuid", "planName": "Growth", "status": "active",
      "billingInterval": "month", "currentPeriodEnd": "2026-08-11T00:00:00.000Z",
      "trialEndsAt": null, "cancelAtPeriodEnd": false,
      "createdAt": "2026-07-11T00:00:00.000Z"
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `PLATFORM_ACCESS_DENIED` (403),
`PLATFORM_ROLE_DENIED` (403), `INVALID_STATUS_FILTER` (400).

---

### `GET /api/v1/platform/billing/subscriptions/mrr`

Platform-wide monthly recurring revenue, computed via a real SQL `SUM`/
`COUNT` aggregate over active subscriptions (yearly plans normalized to
their monthly-equivalent contribution: `priceYearlyCents / 12`). Requires
`support`, `billing`, or `admin`.

**Response `200`**

```json
{ "success": true, "data": { "mrrCents": 148900, "currency": "usd", "activeSubscriptionCount": 23 } }
```

`currency` is always `"usd"` in this release — a v1 simplification assuming
every plan is priced in one currency, not real FX conversion (see
[ARCHITECTURE.md](./ARCHITECTURE.md#risks--known-gaps)).

**Errors**: `UNAUTHENTICATED` (401), `PLATFORM_ACCESS_DENIED` (403),
`PLATFORM_ROLE_DENIED` (403).

---

## Billing (business-facing)

Every route below is business-scoped like any other `/api/v1` route
(`Authorization` + `X-Business-Id`, gated by `billing:view`/`billing:manage`
— not by `platformRole`). Responses never include a raw Stripe customer,
subscription, or price ID; `hasPaymentAccount` is the one derived fact the
frontend needs.

### `GET /api/v1/billing/plans`

The purchasable plan picker. Requires `billing:view`.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid", "key": "growth", "name": "Growth", "description": "For growing teams.",
      "priceMonthlyCents": 9900, "priceYearlyCents": 99000, "currency": "usd",
      "maxBranches": 5, "maxUsers": 20, "features": { "aiSummaries": true }, "sortOrder": 1
    }
  ]
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403).

---

### `GET /api/v1/billing/subscription`

This business's current subscription, or `data: null` if none exists yet (a
real, if increasingly rare, state — not a `404`). Requires `billing:view`.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "uuid", "businessId": "uuid", "planId": "uuid",
    "status": "trialing", "billingInterval": null,
    "currentPeriodStart": null, "currentPeriodEnd": null,
    "trialEndsAt": "2026-07-25T00:00:00.000Z",
    "cancelAtPeriodEnd": false, "canceledAt": null,
    "hasPaymentAccount": false,
    "plan": { "id": "uuid", "key": "starter", "name": "Starter" }
  }
}
```

**Errors**: `UNAUTHENTICATED` (401), `MISSING_BUSINESS_CONTEXT` (400),
`NOT_A_MEMBER` (403), `PERMISSION_DENIED` (403).

---

### `POST /api/v1/billing/checkout`

Creates a Stripe Checkout Session for a new or plan-changing subscription
and returns its hosted URL. Requires `billing:manage`.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `planId` | uuid | must be an active, purchasable plan |
| `interval` | string | `month` or `year` |
| `successUrl` | string | URL, supplied by the caller |
| `cancelUrl` | string | URL |

**Response `200`**

```json
{ "success": true, "data": { "url": "https://checkout.stripe.com/c/pay/..." } }
```

**Errors**: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`MISSING_BUSINESS_CONTEXT` (400), `NOT_A_MEMBER` (403), `PERMISSION_DENIED`
(403), `USER_NOT_FOUND` (404), `PLAN_NOT_FOUND` (404, unknown or retired
plan), `PLAN_NOT_PURCHASABLE` (422, no Stripe price configured for the
requested interval), `STRIPE_SESSION_ERROR` (500).

**Audit**: records `subscription.checkout_started` with `{ planId, interval }`.

---

### `POST /api/v1/billing/portal`

Opens Stripe's hosted Customer Portal (payment method updates, invoice
history, self-service cancellation if configured there). Requires
`billing:manage`.

**Request body**

| Field | Type | Constraints |
| --- | --- | --- |
| `returnUrl` | string | URL to send the browser back to afterward |

**Response `200`**

```json
{ "success": true, "data": { "url": "https://billing.stripe.com/p/session/..." } }
```

**Errors**: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401),
`MISSING_BUSINESS_CONTEXT` (400), `NOT_A_MEMBER` (403), `PERMISSION_DENIED`
(403), `NO_STRIPE_CUSTOMER` (422, still on a card-less trial — nothing to
manage yet).

---

### `POST /webhooks/stripe`

**Not versioned, not under `/api/v1`** — mounted at the Hono app's root,
same precedent as `/health`. Stripe-only; never called by `apps/web` or any
browser, and deliberately not rate-limited (a legitimate post-outage retry
burst from Stripe must never be throttled — the signature check below is
this route's real security boundary).

**Headers**: `Stripe-Signature` required (set automatically by Stripe on
every delivery).

**Request body**: raw Stripe Event JSON, verified via signature before any
field is trusted — never validated against a Zod schema the way every other
route's body is, since the signature check *is* the validation here.

**Response `200`**

```json
{ "received": true }
```

Deliberately not this API's usual `{ success, data }` envelope — Stripe only
inspects the HTTP status code, never the body shape.

**Errors**: `MISSING_SIGNATURE` (400, no `Stripe-Signature` header),
`INVALID_SIGNATURE` (400, verification failed) — neither is ever retried by
Stripe, correctly, since an invalid signature never becomes valid on
redelivery. Any error during event processing (after verification succeeds)
propagates as a generic `500` and **is** retried by Stripe with backoff for
up to 3 days. Reacts only to `customer.subscription.created`/`updated`/
`deleted`; every other event type is acknowledged `200` and ignored.

---

## Permissions Catalog

Seeded by `pnpm db:seed`; add new keys in
`apps/api/src/db/seed/permissions.seed.ts` as features ship.

| Key | Category | Description |
| --- | --- | --- |
| `business:view` | Business | View business profile and settings |
| `business:manage_settings` | Business | Edit business profile and settings |
| `business:delete` | Business | Permanently delete the business |
| `branches:view` | Branches | View branches |
| `branches:manage` | Branches | Create, edit, and delete branches |
| `team:view` | Team | View team members and their roles |
| `team:invite` | Team | Invite new team members and grant roles |
| `team:remove` | Team | Remove a team member's access |
| `roles:view` | Roles | View roles and their permissions |
| `roles:manage` | Roles | Create, edit, and delete roles and permission assignments |
| `audit:view` | Audit | View the business audit log |
| `feedback:view` | Feedback | View customer feedback |
| `feedback:manage` | Feedback | Mark feedback reviewed and remove submissions |
| `loyalty:view` | Loyalty | View customer loyalty accounts, balances, and transaction history |
| `loyalty:manage` | Loyalty | Record purchases/check-ins and confirm reward redemptions at the counter |
| `rewards:manage` | Loyalty | Configure loyalty tiers and the reward catalog (program design) |
| `analytics:view` | Analytics | View sentiment trends, searchable feedback, and AI summaries |
| `analytics:manage` | Analytics | Trigger on-demand AI summary generation (costs a real Anthropic API call) |
| `notifications:view` | Notifications | View business-wide notification settings and the send log |
| `notifications:manage` | Notifications | Configure business-wide delivery settings (email/SMS kill switches, daily SMS cap) |
| `billing:view` | Billing | View the current plan, trial/subscription status, and billing history |
| `billing:manage` | Billing | Change plan, update payment method, and cancel the subscription |

QR code management reuses `branches:view`/`branches:manage` rather than
minting its own keys — a QR code is an attribute of a branch, not its own
permission domain. Self-service notification preference management
(`GET`/`PATCH /notifications/preferences` and the customer equivalent under
`/loyalty/me/*`) needs **no permission at all** — every authenticated
member (staff or customer) manages their own, the same reasoning as a
customer managing their own loyalty account; only the two keys above, which
gate business-wide configuration and the send log, exist. `billing:view`/
`billing:manage` are **business-scoped** permissions, distinct from
`users.platformRole` — a business's own Owner/Admin manage what that one
business pays; a platform admin's `billing` role manages the platform-wide
plan catalog and cross-tenant subscription visibility instead (see the
Platform Admin Console section above). Existing businesses were retroactively
granted these two keys by a one-time idempotent backfill script
(`db:seed:billing-backfill`), since `DEFAULT_ROLES` only applies to roles
seeded going forward.

**Default role grants**

| Role | Permissions |
| --- | --- |
| Owner | all 22 keys, including `business:delete` and `billing:manage` (the only role that gets either) |
| Admin | all except `business:delete` and `billing:manage` — Admin can see what the business is paying (`billing:view`) but not change it, the same irreversible/financial-consequence cut as `business:delete` |
| Manager | `team:view`, `roles:view`, `business:view`, `branches:view`, `branches:manage`, `feedback:view`, `feedback:manage`, `loyalty:view`, `loyalty:manage`, `rewards:manage`, `analytics:view`, `analytics:manage`, `notifications:view`, `notifications:manage` |
| Staff | `business:view`, `branches:view`, `feedback:view`, `loyalty:view`, `loyalty:manage` |

Manager and Staff get **neither** `billing:view` nor `billing:manage` — same
boundary already established for Analytics and Notifications: billing is a
business-strategy/financial concern, not a front-counter task.

Staff is the one role where Loyalty and Feedback diverge: Staff is
*view-only* on feedback (triaging reads as a supervisory action) but gets
`loyalty:manage` too — recording a purchase or confirming a redemption is
literally a front-counter task, so restricting Staff to view-only there
would create a real functional gap. `rewards:manage` (point-cost/tier
*configuration*) stays Manager+ only regardless — letting front-line Staff
edit a reward's point cost is a real fraud vector, distinct from the
day-to-day operations `loyalty:manage` covers. Staff gets **neither**
`analytics:view` nor `analytics:manage` — trend/summary data is
business-strategy information, not a front-counter task; a Staff member
still sees individual feedback via `feedback:view`, just not the aggregated
sentiment reporting. Staff likewise gets **neither** `notifications:view`
nor `notifications:manage`, for the same reason — business-wide delivery
configuration and the send log are a cost/strategy concern, not a
front-counter task. This does not affect Staff's own notifications: every
role, Staff included, manages their personal preferences through the
permission-free self-service endpoints above.

## Not Yet Implemented

Endpoints implied by the platform vision but not part of the Multi-Tenant
Foundation, Branch Management, or QR Engagement modules — do not assume
these exist:

- Team invite/role-management endpoints (`team:*`/`roles:manage` permissions
  are seeded and enforceable, but no route calls `requirePermission` with them
  yet) — also why no business can have more than one member yet
- Push notifications: `notificationChannelSchema` already enumerates `push`
  for forward-compatibility, but `NotificationDeliveryService` has no
  implementation for it — `DELIVERABLE_NOTIFICATION_CHANNELS` (email, sms
  only) is what every route and the preferences UI actually offer today.
- Per-branch automatic scheduled summaries: `src/index.ts`'s `scheduled`
  export already fires a **business-wide** `generate_summary` job for every
  business, weekly (Monday 00:00 UTC) and monthly (1st, 00:00 UTC) — see
  `wrangler.toml`'s `[triggers]`. It does not additionally enqueue one per
  branch; a branch's own rollup is only produced by an explicit
  `POST /analytics/summaries/generate` call with a `branchId`. The schema
  (`feedback_summaries.branchId` nullable) and `SummaryService` already
  support a per-branch schedule if this is ever needed — it just isn't
  triggered automatically today.
- Birthday bonuses: `loyalty_settings.birthdayBonusPoints` exists and is
  configurable, but nothing schedules or awards it yet — no route or job
  reads a customer's `birthday` and triggers a `birthday_bonus` transaction.
  The schema/settings support it; the trigger mechanism (likely a scheduled
  Queue job) is not built.
- Referral bonuses: `LoyaltyAccountService.enroll()` accepts a
  `referredByCustomerId` and will award the referrer correctly if given one,
  but no public endpoint currently exposes a way to *pass* that field — a
  raw customer UUID isn't a safe thing to put in a shareable referral link.
  A proper referral-code scheme (short, non-guessable, mapped back to a
  customer) is designed but not built.
