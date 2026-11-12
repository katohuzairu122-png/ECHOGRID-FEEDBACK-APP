# D-C1 — Dedicated cashier permissions and role-grant reconciliation (change record)

**Scope: development only.** No deployment, no merge, no migration and no role-grant change applied to any staging, production or connected Neon database. Live databases were touched only by the authorized **read-only migration check** in section 8 (migration metadata only).
Baseline `origin/main` @ `15e6a440b70547ddb77f57297e5287acf06de515`. No overlapping D-C1 implementation existed (verified: no D-C1 commits or branches; #367, #368 and #369 only hid the screens and gated manual adjustment).

## 1. Problem (verified earlier, re-verified here)

Default Staff held `loyalty:view`, `loyalty:manage`, `feedback:view`, `messages:view` and `messages:send`. Hiding the cashier UI did not stop a Staff token calling `GET /loyalty/accounts`, `/loyalty/tiers`, `/feedback` or `/messaging/conversations` (all returned 200 over real HTTP before this change).

## 2. Permission model

| Permission                                        | Status                  | Authority                                                                           |
| ------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `loyalty:serve`                                   | **New**                 | Resolve a signed customer QR, record a purchase, review and confirm a redemption    |
| `loyalty:accounts:view`                           | **New**                 | Business-wide account directory, account detail, transaction history                |
| `loyalty:adjust`                                  | **New**                 | Manual balance adjustment                                                           |
| `loyalty:view`                                    | Kept (narrowed meaning) | Loyalty programme configuration reads: settings, tiers, rewards, reward dashboard   |
| `rewards:manage`                                  | Unchanged               | Programme configuration writes                                                      |
| `loyalty:manage`                                  | **Legacy**              | No route requires it any more; kept in the catalog so existing grants do not dangle |
| `feedback:view`, `messages:view`, `messages:send` | Unchanged keys          | Routes unchanged. **The fix is removing them from the default Staff grants**        |

No redundant permission was created: no existing key was narrow enough to separate counter service from administration.

## 3. Route-to-permission matrix

| Route                                                                   | Before                                          | After                                                | Tenant and branch scope                       | Returns                                                                 |
| ----------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| `POST /loyalty/actions/resolve-customer`                                | `loyalty:view`                                  | `loyalty:serve`                                      | Business from tenant context; branch honoured | Customer id, membership state, permitted actions for THIS business only |
| `POST /loyalty/accounts/:id/purchase`                                   | `loyalty:manage`                                | `loyalty:serve`                                      | Business and optional branch                  | The recorded purchase                                                   |
| `GET /loyalty/redemptions/:code`                                        | `loyalty:view`                                  | `loyalty:serve`                                      | Business                                      | One redemption                                                          |
| `POST /loyalty/redemptions/:code/confirm`                               | `loyalty:manage`                                | `loyalty:serve`                                      | Business and branch                           | The confirmed redemption                                                |
| `GET /loyalty/accounts`, `/accounts/:id`, `/accounts/:id/transactions`  | `loyalty:view`                                  | `loyalty:accounts:view` + business-wide access       | Business-wide only                            | Directory and history                                                   |
| `POST /loyalty/accounts/:id/adjust`                                     | `loyalty:manage` + `rewards:manage` (from #369) | `loyalty:adjust` + business-wide access              | Business-wide only                            | Adjusted account                                                        |
| `GET /loyalty/settings`, `/tiers`, `/rewards`, `/rewards/:id/dashboard` | `loyalty:view`                                  | `loyalty:view` (no longer held by Staff)             | Business-wide only                            | Programme configuration                                                 |
| `PATCH /loyalty/settings`; tier and reward writes                       | `rewards:manage`                                | unchanged                                            | Business-wide only                            | —                                                                       |
| `GET /feedback`, feedback administration                                | `feedback:view` / `feedback:manage`             | unchanged routes; Staff default no longer holds them | Business, branch                              | —                                                                       |
| `GET /messaging/conversations` and sends                                | `messages:view` / `messages:send`               | unchanged routes; Staff default no longer holds them | Business-wide only                            | —                                                                       |

Resolver (`LoyaltyActionResolver`) now derives every staff action from `loyalty:serve`; a role holding only legacy `loyalty:view` or `loyalty:manage` gets no loyalty action (fails closed). `GET /businesses/:id/action-contexts` needs only authentication and returns the caller's own contexts, so the cashier workspace does not depend on any removed permission.

## 4. Default roles after D-C1 (new businesses)

| Role                  | Result                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff                 | `business:view`, `branches:view`, `loyalty:serve` only                                                                                            |
| Owner, Admin, Manager | All previous grants plus the three new permissions. Manager still holds no `billing:manage` or `business:delete`; Admin holds no `billing:manage` |

## 5. Existing businesses and custom roles: evidence-based reconciliation

No schema change is needed: permissions and grants are **data** (`permissions`, `role_permissions`), seeded by scripts, so **no drizzle migration is added** and the migration journal and Gate 2 pins are untouched.

`db/seed/loyalty-permissions-reconcile.seed.ts` (script `db:seed:loyalty-permissions-reconcile`) applies a plan produced by pure functions in `rbac/loyalty-permissions.ts`. It is dry-run by default, needs `--apply` plus `RBAC_RECONCILE_CONFIRM=<phase>`, runs in one transaction, writes one `audit_log` row per changed role, and is idempotent.

| Evidence available in the database                                                                     | Treatment                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| System role named Staff whose grants are a **subset** of the historical default (plus `loyalty:serve`) | **Unmodified default**: phase A adds `loyalty:serve`; phase B removes the five legacy keys                                                          |
| Same role with any additional grant, or a renamed or non-system role                                   | **Customised: preserved**. Phase A only adds equivalents; phase B never reduces it; it is **listed for an owner decision**                          |
| Owner, Admin, Manager                                                                                  | Additive only. `loyalty:adjust` is granted only to roles that held **both** `loyalty:manage` and `rewards:manage` (exactly who could adjust before) |
| Custom role with `loyalty:manage`                                                                      | Gets `loyalty:serve`; never gains `loyalty:adjust` unless it also held `rewards:manage`                                                             |
| Custom role with `loyalty:view` (not a default Staff)                                                  | Gets `loyalty:accounts:view` so directory access is not silently lost                                                                               |
| Role with `loyalty:view` but no `loyalty:manage`                                                       | Does **not** gain `loyalty:serve` (that would add a capability). It loses QR resolve and redemption lookup. **Reported, not silent**                |
| Unknown or ambiguous                                                                                   | Never changed; listed                                                                                                                               |

What the data cannot prove: whether an extra grant on a Staff role was deliberate. That is why such roles are reported and not reduced.

### Required order (a wrong order causes an outage or leaves the exposure)

1. Seed the permission catalog (`db:seed`) so the three new keys exist.
2. **Phase A (additive) dry-run, then apply** while the OLD API is still deployed. It is harmless to the old code.
3. Deploy the new API.
4. **Phase B (reduce) dry-run, review, then apply.**
5. Review the list of roles reported for an owner decision.

Verified on a disposable database (section 7): deploying the new API before phase A denies service routes to **every** role in an unreconciled business, owners and managers included. Reducing before phase A does nothing (the planner will not strand a cashier).
Each step needs its own owner authorization per environment, and a Neon restore point beforehand.

### Rollback and forward recovery

- Phase A: delete the three new keys from the roles listed in its `audit_log` rows.
- Phase B: re-grant the five legacy keys to the role ids recorded in its `audit_log` rows. Demonstrated: restoring from the audit record and re-running phase B returns the role to the three-key default.
- Code: redeploy the previous release. After phase B the old API would deny Staff service, so roll back phase B first.

## 6. Defence in depth

API routes enforce the permission; the service layer and tenant middleware are unchanged; unknown or failed permission lookups fail closed (tested); the PR #369 web restrictions are preserved and now classify by `loyalty:serve`; every reconciliation writes `audit_log`. No bypass flag, hardcoded account or fallback grant was added. No customer name or phone search was added (a test pins the exact list of loyalty `GET` routes).

## 7. Verification actually executed

- API: `tsc` clean; 167 test files / 2632 tests pass. New real-router matrix: 94 tests across Staff, Manager, Admin and Owner for 20 routes, plus tenant, branch, unauthenticated, lookup-failure and enumeration tests; 26 planner tests.
- Mutation checks: reverting adjustment to `loyalty:manage`, the directory to `loyalty:view`, resolve to `loyalty:view`, purchase to `loyalty:manage`, and deleting the adjust permission each make tests fail (2, 2, 4, 4 and 5 failures).
- Web: `tsc` clean; 80 files / 439 tests pass.
- Real stack on a disposable local PostgreSQL 16 with all 68 migrations: a new business's cashier gets 403 on directory, tiers, feedback, messaging and adjustment and reaches service logic; an unreconciled business denies everyone (state 1); after phase A the legacy cashier serves again but keeps the exposure (state 2); after phase B it equals the new default (state 3). Replays of both phases changed 0 roles. Custom roles were preserved and reported. Rollback from the audit record verified.
- **Not run:** PostgreSQL 18 locally (CI uses it), Neon, Cloudflare, any production or staging role data, real-device checks.

## 8. Authorized read-only migration check (2026-11-12)

One SELECT against `drizzle.__drizzle_migrations` comparing the repository journal (68 entries) with each database. No other table was read.

| Database                                                                                  | Applied rows | Matched by timestamp | Matched by SQL hash | Pending                               |
| ----------------------------------------------------------------------------------------- | ------------ | -------------------- | ------------------- | ------------------------------------- |
| Production, project `divine-voice-54333763`, branch `br-blue-paper-atrcoge1`              | 67           | 67                   | 59                  | `0067_customer_preferred_locale` only |
| Staging default branch, project `lucky-glitter-47218268`, branch `br-bold-water-aukjlvw3` | 67           | 67                   | 54                  | `0067_customer_preferred_locale` only |

Consequences: staging is at 67 (the earlier note that its default branch was at 45 is no longer true), and only `0067` is pending in both. The SQL hash differs for 8 production and 13 staging entries; this matches the documented historical SQL hash reconciliation work and was not investigated further here. Cloudflare and Hyperdrive bindings were not read. `0067` was NOT applied.

## 9. Owner decisions requested

| ID     | Question                                                                                                                                                       | Author's view                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| D-C1-a | Authorize phase A, then deployment, then phase B per environment (dry-run output reviewed first)                                                               | Staging first, production after a staging rehearsal    |
| D-C1-b | Custom roles reported by the dry run (extra grants, or holding legacy keys): reduce, keep, or replace case by case                                             | Keep until reviewed per business                       |
| D-C1-c | Roles with only `loyalty:view` lose QR resolve and redemption lookup. Accept                                                                                   | Accept; they never could record a purchase             |
| D-C1-d | Does Staff still need `business:view` and `branches:view`? The cashier workspace does not use them; `branches:view` allows reading branch details and QR codes | Remove both after a staging check; left unchanged here |
| D-C1-e | Retire the legacy `loyalty:manage` key from the catalog                                                                                                        | Later, after every grant has moved                     |
| D-C1-f | Whether feedback and messaging should also get dedicated cashier-excluding permissions                                                                         | No; removing them from Staff is sufficient             |

## 10. Remaining exposure

- Customised roles that still hold the legacy keys keep that access until the owner decides (D-C1-b).
- Until phase B runs in an environment, its default Staff roles keep the exposure.
- `branches:view` and `business:view` remain on Staff (D-C1-d).
- Name and phone customer search remains unbuilt (D-C2).
