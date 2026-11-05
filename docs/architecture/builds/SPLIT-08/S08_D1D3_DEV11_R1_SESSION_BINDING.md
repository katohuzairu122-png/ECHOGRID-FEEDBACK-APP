# S08 D1/D3-DEV-11-R1 — Session-Specific Administrator Authority

Status: DEVELOPMENT ONLY. Inert. Financial activation: NO-GO. No Stripe contact, no route, no deployment. One additive migration: **0063**. Stacked on PR #232 (the DEV-11 re-land on `main`), which is stacked on nothing: DEV-10 is already on `main`.

## Problem corrected
DEV-11 accepted an administrator access token if the user had *any* live refresh-token record. A revoked session therefore kept authority while the same user had another live session, and logout of one session did not end it for a token already issued.

## What changed
| Area | Change |
|---|---|
| Schema (0063) | `refresh_tokens.session_id uuid` NULL plus index `(user_id, session_id)`. Additive: no data statement, no default; existing rows keep NULL (legacy). Applies for a non-superuser migrator. |
| Token | Access tokens carry a **signed** `sid` claim (a v4 random UUID, created at the trusted login/signup boundary). `signAccessToken(..., sessionId?)` refuses a malformed id; `verifyAccessToken` rejects a malformed claim. Ordinary verification of tokens without `sid` is unchanged. |
| Issue / refresh / logout | Login and signup start a NEW session. Refresh copies the id from the row being rotated (never from the request); a legacy row (NULL) gets an id at its first refresh. Logout revokes the presented row **and every row of that session**, so a stale rotated token still ends it. Revocation of the session's refresh row (single revoke, revoke-all, replay containment) ends it. |
| Administrator boundary | `authenticateAdminSession` now requires the `sid` (legacy tokens: `SESSION_BINDING_MISSING`, fail closed) and checks the *exact* session with `RefreshTokenRepository.isSessionLive(userId, sid, now)`: this user, this session id, unrevoked, unexpired. Another live session of the same user, or any session of another user, cannot satisfy it. The database still decides administrator status and role. |
| Use-time re-verification | `createSessionRevalidator` re-checks, at every privileged call, the token expiry, the exact session, and the administrator's status/role against persisted state. `ReadAuthorizationAdminService` **requires** it (constructor) and calls it before propose / approve / revoke / status / audit history, so revoking a session stops the very next call, not the next authentication. The context binding (user, session id, token expiry) lives in a module-private WeakMap. |

## Compatibility
Workload identity, credential custody, signing-key custody, closed read-method registry, trusted-runtime provenance, signed settlement authorization and D4 consumption are unchanged and covered by their existing suites (all re-run). An administrator context, token or bearer string is neither a workload identity nor a way to resolve a Stripe secret (tested). The operational approval policy stays disabled; no route.

## Known limits
1. No HTTP route or middleware wires the administrator boundary yet; the ordinary `authenticate` middleware is deliberately unchanged (it does not check the session).
2. The `sid` shape check in `admin-session.ts` is redundant with `verifyAccessToken`'s (an equivalent mutant kept as defence in depth).
3. Legacy sessions lose administrative authority until their next refresh (by design).
4. Access-token lifetime (15 min) is unchanged; use-time revalidation, not token expiry, is what makes revocation immediate for the privileged services.
