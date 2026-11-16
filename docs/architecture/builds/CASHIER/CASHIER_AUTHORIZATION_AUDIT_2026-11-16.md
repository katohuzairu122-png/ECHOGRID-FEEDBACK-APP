# Cashier customer-servicing authorization audit (read-only)

**Status: DOCUMENTATION ONLY.** Baseline `origin/main` @ `341e15a` (2026-11-16). Scope: trace the cashier workflow and verify authorization at the **API and service boundaries**, not only in the UI. Method: code reading plus the existing tests named below; no new exploit or live system was used. **Result: no demonstrated defect; no repair PR is justified.** Observations that need an owner decision are listed in section 3; none was changed.

## 1. Workflow trace
| Step | Where it is enforced | Finding |
|---|---|---|
| 1 Login and session | `auth/cashier-auth.service.ts` | Eligibility is exactly the existing `loyalty:serve` permission at the chosen business and branch, resolved from the database; user must be `active`, business `active`; a business-wide holder with branches must choose a branch; a chosen branch must be among the user's eligible branches; refresh re-checks eligibility (role removal, suspended business, removed branch end the session) |
| 2 Business/branch binding | `auth/jwt.ts` (cashier token), `middleware/authenticate.ts`, `middleware/tenant-context.ts` | Token carries signed `bid`/`brid`; headers may only repeat them; a mismatch is refused with `CASHIER_CONTEXT_MISMATCH`; the access token lives only while its session does (revocation) |
| 3 Route allow-list | `middleware/cashier-scope.ts` | Deny-by-default: exactly 8 routes (resolve-customer, lookup-customer, lookup-purchase, account purchase, redemption lookup/confirm, `businesses/me`, `auth/me`). A global guard runs before every route and `authenticate` checks again; a denial is audited. Administrative areas are absent |
| 4 QR scan / resolve | `loyalty/loyalty.routes.ts` -> `LoyaltyActionResolver` | `requirePermission('loyalty:serve')`; business from the signed context; signed QR token verified server-side |
| 5 Manual search | `loyalty/customer-lookup.service.ts` | Rate-limited per business+cashier, miss throttle, audited with an HMAC of the phone (never the number), signed short-lived lookup token as the only handle; the account id is not returned on this path; only verified phones |
| 6 Customer resolution | same | Business-isolated; membership state decides the permitted `actions` returned to the UI |
| 7 Loyalty actions | `purchase`, `redemptions/:code(/confirm)` | `loyalty:serve` required; redemption confirm applies branch eligibility from the bound branch (S6.8); purchases carry staff id and bound branch; idempotency key required |
| 8 Owner/manager restrictions | `requirePermission` + `requireBusinessWideAccess` on every administrative loyalty route | Accounts, adjust, settings, tiers, rewards need business-wide access; a cashier token cannot reach them at all (allow-list) and a branch-scoped staff session fails `requireBusinessWideAccess` |

Existing tests that pin this behavior include `auth/cashier-auth.*.test.ts`, `jwt-cashier.test.ts`, `middleware/audit-cashier.test.ts`, the cashier scope/session integration suites and `cashier-activity-scope.integration.test.ts`.

## 2. Conclusion
Authorization is enforced at the API (allow-list, signed binding, per-route permission, business-wide gate) and re-checked from the database on refresh; the UI is not the control. I found no route a cashier token can reach outside the allow-list, no way for a header to change tenant or branch, and no administrative loyalty route without a business-wide gate. The earlier QR work (#471, #472) was client-side (camera permission and navigation); it did not touch authorization.

## 3. Observations for the owner (not defects, nothing changed)
1. **Purchase by account id.** `POST /loyalty/accounts/:id/purchase` accepts an account id for the caller's business. The resolve path returns `loyaltyAccountId` to a cashier for a customer they legitimately resolved, so this is by design; ids are random UUIDs and the account lookup is business-scoped. If the owner wants purchases to require a fresh resolve/lookup token instead of a bare account id (as lookup-purchase already does), that is a design change with its own tests, not a bug fix.
2. **Branch-bound cashier and redemption codes.** `GET /loyalty/redemptions/:code` is business-scoped; branch eligibility is applied at **confirm**. A cashier at branch A can therefore read the details of a valid code issued for the business (not confirm it where ineligible). Decide whether lookup should also be branch-scoped.
3. **"Cashier authorization fixes" in the directive** had no written specification; if a specific failure was observed (for example a device login or a role that cannot start a session), please provide the case so a regression test can reproduce it.

## 4. Not done
No device test, no staging check, no change to permissions. Nothing here is a security certification.
