# Cashier workspace, QR scanning and RBAC remediation — change record

**Scope: development only.** No deployment, no merge, no migration applied to any live system, no production role-grant change, no Stripe/SMS/advertising/Partner Credit activity.
Baseline `origin/main` @ `b2f85ac`. Stacked on PR #367 (`0ba9563`) with PR #368 (`ce18b21`) merged in; #365 and #366 are untouched.

## 1. Finding-to-fix matrix

| ID  | Finding                                                                    | Root cause                                                         | Fix in this branch                                                                                                                                                  | Status                                                                         |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| F1  | Cashier More menu still showed Customer list, Feedback, Messages           | #367 built a cashier list that included them                       | Cashier navigation is Serve customers + Support; sign-out/install stay as utilities. All management pages gated (see F3/F4)                                         | Fixed, browser-verified                                                        |
| F2  | `loyalty:manage` (held by Staff) also authorized manual balance adjustment | One permission covered counter service and administration          | `POST /loyalty/accounts/:id/adjust` now also requires `rewards:manage`. Real-router tests plus real-HTTP probes                                                     | **Partly fixed** — see §3 gate D-C1 for directory reads, feedback and messages |
| F3  | Unknown permissions showed the full menu                                   | Permission-read failure fell through to "everything"               | Three states: cashier / management / unavailable. Unavailable shows only Support + sign-out and an explicit restricted panel on every management page               | Fixed, browser-verified (owner and cashier, 503 injected on `/businesses/me`)  |
| F4  | Tiers/Rewards guards redirected to the (administrative) loyalty list       | Guard target chosen without checking that page's own authorization | Cashier → cashier home; unknown → unavailable panel; known without `rewards:manage` → forbidden panel. Never another privileged page                                | Fixed                                                                          |
| F5  | "Search customers" implied a lookup that does not exist                    | Label vs. behaviour mismatch                                       | Button relabelled "Verify with QR token" (4 locales); it focuses the manual token field and never navigates. **No name/phone search was built**                     | Fixed; real search is gate D-C2                                                |
| F6  | Scanner needed native `BarcodeDetector`                                    | Missing API was treated as missing camera                          | Local decoder (jsQR 1.4.0, bundled, loaded on demand, no network) when the native API is absent; image-upload fallback; HTTPS check; one-shot detect; track cleanup | Fixed; Chromium + fake camera verified; real Android NOT RUN                   |
| F7  | No real-account browser flow                                               | —                                                                  | Disposable local Postgres + real API + production web build; 45 + 9 browser assertions, 14 API probes                                                               | Executed (see §4)                                                              |
| F8  | Migration history                                                          | Documented in #366                                                 | Not touched. 0067 was applied only to a **local throw-away Postgres 16** for testing                                                                                | Historical only                                                                |

## 2. Permissions before / after

| Operation (route)                                                                  | Cashier (default Staff) before | Cashier after                         | Manager / Admin / Owner           |
| ---------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------- | --------------------------------- |
| Manual adjustment `POST /loyalty/accounts/:id/adjust`                              | allowed                        | **403 PERMISSION_DENIED**             | unchanged (hold `rewards:manage`) |
| Tiers / rewards / settings writes                                                  | 403                            | 403                                   | allowed                           |
| Resolve QR, record purchase, confirm redemption                                    | allowed                        | allowed (unchanged)                   | allowed                           |
| Settlements, billing                                                               | 403                            | 403                                   | per grants                        |
| `GET /loyalty/accounts`, `/loyalty/tiers`, `/feedback`, `/messaging/conversations` | 200                            | **200 (UI hidden, API still allows)** | allowed                           |

No existing role grant, seed, schema or migration was changed.

## 3. Decision gates (not implemented here)

**D-C1 — API-level separation of cashier from administration.** The default Staff role holds `loyalty:view`, `feedback:view`, `messages:view`, `messages:send`, `branches:view`; hiding screens does not stop a Staff token calling those APIs. A correct fix needs dedicated permissions and a role-grant backfill.
Proposed (undecided): `loyalty:serve` (resolve QR, purchase, redemption), `loyalty:accounts:view` (directory and history), `loyalty:adjust` (manual adjustment), and removing `feedback:*`/`messages:*` from the cashier default.
Requires: owner approval of names; a reviewed seed + backfill migration; a per-business report of customised roles before anything is changed; staging dry-run; then a separate production gate. Until then the interim `rewards:manage` gate on adjustment stands.

**D-C2 — Customer search by name or phone.** Not built. It needs a new minimally scoped endpoint: business-scoped membership only (never the platform customer table), minimum fields, exact-match or ≥N-character rules, rate limiting, audit entry per search, no enumeration (uniform responses, no counts), consent review. Owner decision required before any implementation.

## 4. Verification actually executed

- API: `tsc` clean; 166 test files / 2535 tests pass, including the new real-router boundary test (13 tests). Mutation check: removing the new gate makes exactly the two adjustment tests fail.
- Web: `tsc` clean; 79 files / 422 tests pass; production `next build --webpack` succeeds; ESLint 0 errors (5 warnings, none in changed files).
- Real stack: Postgres 16 (not 18, which CI uses) with all 68 migrations; real Worker via `wrangler dev --local`; production Next build; synthetic fixture users and business only.
- Browser (Chromium, desktop and 390 px): cashier lands on Serve customers, 14 management URLs redirect to it, More menu has only Support + sign-out; manager and owner keep their workspaces; permission-read failure shows only Support + restricted panels; fallback decoder reads a live fake-camera QR and an uploaded image; camera-denied message; no token in URL; no horizontal overflow; real purchase and reward-handoff flows with a signed customer QR.
- API probes (real HTTP): cashier 403 on adjust, tiers, rewards, settings, billing, settlements; manager reaches adjustment logic; cashier targeting a business it does not belong to gets `NOT_A_MEMBER`; the same customer QR in a business where the customer is not a member yields no loyalty actions and no account id.
- **Not run:** real Android device, Safari/iOS/Firefox, customer-facing flows beyond the redemption call, load or rate-limit behaviour, PostgreSQL 18, Neon, Cloudflare.

## 5. Observations (not changed)

- Creating a duplicate loyalty tier returned HTTP 500 `INTERNAL_ERROR` instead of a 409 (observed once; cause not investigated).
- Layouts and pages render independently in Next, so the new gates protect the visible UI; the API remains the authority.
- Staff language control for cashiers is not part of this change (the shared selector serves customer and public surfaces).
