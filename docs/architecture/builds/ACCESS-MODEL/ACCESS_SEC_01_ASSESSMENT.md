# ACCESS-SEC-01: platform administrator security assessment (design only)

**Status: ASSESSMENT AND DESIGN ONLY. Nothing here is implemented, enabled or changed. No privileged account was created, no MFA or Cloudflare Access policy was touched, and no production setting was changed.**
Written 2026-11-13 from the code on `main` `532e65c4` and read-only checks of production. Labels: VERIFIED, PROPOSED, BLOCKED, NOT IMPLEMENTED, NOT TESTED.
**ACCESS-SEC-01 is a prerequisite for expanding the platform business administration area (AM-C).**

## 1. Verification of the reported risks

| Reported risk                                          | Finding                                                                                                                                                          | Status                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| No mandatory second factor for platform administrators | Confirmed. The only one-time-code login in the code is for **customers**. Staff and platform sign-in is email and password only.                                 | VERIFIED                                          |
| Platform administrators have cross-business access     | Confirmed. Platform roles read across all businesses; `admin` can change a business's status.                                                                    | VERIFIED                                          |
| No in-product way to grant platform roles              | Confirmed. Nothing in the API or web app writes a user's platform role. It is set only by the setup script `db:seed:platform-admin` or directly in the database. | VERIFIED                                          |
| Only one active platform administrator in production   | Confirmed. One user holds a platform role, `admin`, active (read-only database count, 2026-11-13).                                                               | VERIFIED                                          |
| No break-glass recovery administrator                  | Confirmed by the count above: there is no second admin. A documented recovery procedure was not found.                                                           | VERIFIED (no second account); procedure NOT FOUND |

## 2. How platform authentication works today (VERIFIED)

- A platform user is an ordinary user with a platform role, signing in at `/login` with email and password. Access tokens last 15 minutes; refresh tokens last 30 days.
- Every platform request re-reads the user from the database and requires an active user with an allowed platform role (`requirePlatformRole`), so removing a role or deactivating a user takes effect immediately for new requests.
- Platform routes are refused while a request carries an impersonation token.
- Platform changes such as a business status change are written to the audit log.

## 3. Findings that need an owner decision

1. **Impersonation is implemented and live.** The console has an impersonate button and the API has `POST /platform/businesses/:id/impersonate` (roles `support` and `admin`), issuing a 30-minute token and recording `user.impersonation_started`. The owner's amendment to D1 says impersonation is **not approved for v1**. These conflict. Recommendation: the owner decides whether to disable the capability until it has its own approved design (support purpose, time-limited elevation, full evidence, no silent escalation, financial actions protected). Disabling is a code change needing its own authorization; nothing was changed here.
2. **Single admin account, no recovery path.** Losing that login would require a database change.
3. **No second factor** on an account that can act across every business.

## 4. Recommended architecture (PROPOSED)

### Layer A (primary): application MFA for every user with a platform role

- Enforced **in the API**, because the API is what authorizes every request, not only the console page.
- Factors: password plus a time-based code (authenticator app) or a passkey. A platform user cannot hold a session that is usable for platform routes without a verified second factor.
- Step-up: sensitive platform actions (business status change, plan edits, role changes) require a recent second-factor check (proposed: within 15 minutes).
- Session limits for platform sessions (proposed): access token 15 minutes as today; shorter refresh lifetime than 30 days (proposed 12 hours absolute, with re-authentication after idle); revocation on password change, role change and logout, with a "sign out everywhere" action.
- Recovery codes: single-use, stored hashed, shown once.

### Layer B (additional): Cloudflare Access at the entry boundary

- Place Access on the **`/platform` web path**, and on the **API's `/platform/*` paths**, with a service-token arrangement so the web Worker's server calls to the API still work. A page-only Access rule is **not sufficient**: the privileged API is reachable on its own address, so it must have equivalent protection.
- Access adds a perimeter (identity provider, device or network conditions) but does not replace Layer A. It is a different failure domain.

### Are both needed?

Yes for platform administrators: Layer A protects every API path and follows the identity; Layer B reduces exposure of the privileged surface. If only one is built first, build **Layer A**. Layer B alone would leave the API protected only by a password.

## 5. Privileged role lifecycle (PROPOSED)

1. **Provisioning:** an admin-only role-management function (with step-up) that grants and revokes platform roles, cannot grant itself a higher role, and refuses to remove the last active admin. Every change audited.
2. **Dedicated accounts:** platform roles are held by accounts used only for platform work, with their own email and unique password, not members of a business team.
3. **Break-glass:** at least two admins. The second is a recovery account whose credentials and recovery codes are stored offline; its use triggers an alert.
4. **Lost device or account:** recovery through recovery codes, then a second admin, then an owner-authorized database procedure with a written audit entry; document the exact steps before building.
5. **Least privilege:** `support` and `billing` for anyone who does not need `admin`.
6. **Audit and alerting:** log and alert on platform sign-in, failed second factor, role changes, business status changes and any impersonation.
7. **Cross-business authorization:** platform roles must not be granted automatically to business Owners or Managers; business roles and platform roles stay independent.

## 5a. Cloudflare connection and verified facts (2026-11-13)

**Connection used (VERIFIED):** this session has no direct network path to Cloudflare (the API, dashboard and the production hostnames return a proxy refusal) and no stored token. A **Cloudflare Developer Platform connector** became available and works for **read-only** listings across two accounts: the owner's personal account (Echo Grid) and **INFINICUS LLC**. Only list and documentation-search tools were used; nothing was created, edited or deleted. The connector announces itself as **deprecated**, with the Cloudflare API connector as its replacement, and it exposes delete tools for databases, KV, R2 and Hyperdrive, which is more power than this work needs.

**What the connector cannot read:** the Workers plan, the active deployment, metrics, billing, Access and Zero Trust settings, Pages projects, PlanetScale resources. Those need either the dashboard or a replacement connector with a **read-only API token** scoped to Access (apps and policies, read), Workers analytics and scripts (read), and billing (read). Granting that token is an owner decision; this document does not request or use one.

| Fact                                        | Value                                                                                                                                                                                                                                                                                  | Status                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Echo Grid account Workers                   | production web and api, staging web and api                                                                                                                                                                                                                                            | VERIFIED                            |
| Production web last modified                | 2026-11-13 16:56:43 UTC, matching the production Web-only release (run 43465438302)                                                                                                                                                                                                    | VERIFIED                            |
| Production api last modified                | 2026-11-13 12:16:01 UTC, matching the production release API deploy                                                                                                                                                                                                                    | VERIFIED                            |
| Production database                         | Hyperdrive config `echo-grid-feedback-db` points at a **Neon** host (us-east-1); the staging config is also Neon. No PlanetScale.                                                                                                                                                      | VERIFIED                            |
| Both Hyperdrive configs modified            | 2026-11-13 16:35:50 UTC (within a fraction of a second of each other); coincides with the owner's reported plan upgrade, consistent with it but not proof                                                                                                                              | VERIFIED time; cause UNVERIFIED     |
| R2                                          | `echo-grid-feedback-uploads` and the staging bucket exist (keep)                                                                                                                                                                                                                       | VERIFIED                            |
| INFINICUS LLC account                       | Workers `infinicus-voice` and `infinicus-voice-serviceifcloudflareasks`; KV `INFINICUS_USERS`, `INFINICUS_WAITLIST` and preview copies; D1 `infinicus_db` and `infinicus-voice-auth`; no Hyperdrive; R2 not enabled. The KV and D1 IDs match `infinicus-validation`'s `wrangler.toml`. | VERIFIED                            |
| Possible leftovers in the Echo Grid account | KV `infinicus_users` and `INFINICUS_WAITLIST` and D1 `infinicus_db` whose IDs do **not** match the Infinicus project's configuration                                                                                                                                                   | VERIFIED existence; purpose UNKNOWN |
| Workers plan after the upgrade              | not readable through the connector                                                                                                                                                                                                                                                     | UNVERIFIED                          |

**Cloudflare documentation checked through the connector (VERIFIED against the docs):**

- Free plan CPU time is **10 ms per HTTP request**; Paid defaults to **30 seconds** and can be raised to 5 minutes. The docs say server-rendered applications usually need Paid. Each isolate has some leeway for occasional overage and is terminated if the limit is hit consistently, which fits both Web versions showing some CPU-limit errors.
- **Access can protect a specific hostname or path**, and a self-hosted Access application is deny by default. **Service tokens** (client ID and secret headers) let a machine call an Access-protected application without a user login.
- Not confirmed in the documentation that was returned: the Zero Trust Free plan's user limit. The 50-user figure comes only from the owner's invoice.

**Consequence for the Layer B design (PROPOSED):** Access in front of `/platform` on the Web hostname is feasible. Protecting the API's `/platform/*` paths is also feasible, but the Web Worker's server-side calls would then need a **service token** sent with each API request. That is a code change in the Web API client plus two stored secrets, so it needs its own authorization and a staging test. It does not replace Layer A (application MFA).

## 6. What is NOT being done by this document

No MFA enabled, no Cloudflare Access policy created, no platform account provisioned, no role changed, no secret created. Each needs separate owner authorization.

## 7. Acceptance criteria for the future build

A platform route is refused without a verified second factor; a role removal ends access on the next request; the last admin cannot be removed; step-up is enforced on listed actions; every grant, revoke and failed factor is audited; the privileged API paths are protected independently of the web page; and a recovery drill is performed once in staging.

## 8. Owner rulings, 2026-11-13 (recorded; nothing built or activated)

- **Order:** application MFA enforced in the API for all platform-role users **first**; passkey or authenticator-app verification; recent-authentication step-up for sensitive actions. Cloudflare Access may be added later as defense in depth, **not** as a replacement for API authorization.
- **Break-glass (approved with conditions):** single-use, securely hashed recovery codes; secure enrollment, regeneration and revocation; rate limiting; audit logging; and a **separately controlled emergency administrator** with restricted recovery procedures (detailed design still to be written and approved).
- **Impersonation:** Option A. Disable it through a server-enforced feature flag in a separately authorized, tested release; preserve historical audit records; keep the code; do not disrupt other administrative permissions. **It is still live in production until that release.**
- **Status:** none of this is implemented. No MFA, flag change, account provisioning or Cloudflare Access policy was made. Each needs its own authorization.
