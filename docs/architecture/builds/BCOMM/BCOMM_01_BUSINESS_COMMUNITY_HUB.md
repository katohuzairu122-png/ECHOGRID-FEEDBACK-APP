# BCOMM-01 — Business Community hub and Community-first homepage

Status: **IMPLEMENTED — VALIDATION PENDING on hosted CI** (development only). Nothing merged, deployed, migrated, enabled or activated. Community stays disabled.

## 1. What was reconciled first (existing architecture, nothing duplicated)
- **Entry and routing.** Every sign-in path, bounce and link already targets `/dashboard` (`loginAction`/`signupAction` default `next`, middleware "already signed in" bounce, the `/` redirect, the workspace home link, `RestrictedPanel` retry). The secure `next` handling (`safeInternalPath`) is untouched. Mandatory onboarding is `CreateBusinessForm` at `/dashboard`; every dashboard page sends a user with no business back there.
- **Roles.** There is no role name in the web app: workspace kind is derived from effective permissions (`classifyWorkspace`: `cashier` | `management` | `unavailable`). Owner/admin/manager hold management permissions; counter staff (default "Staff"/Cashier) hold `loyalty:serve` only; unknown permissions are `unavailable` (fail closed). Cashiers already reach "Serve customers" through the server-side `managementGate`.
- **Navigation.** `DashboardNav` builds one permission-filtered list for `WorkspaceNavigation` (sidebar + mobile bottom bar showing the first `primaryCount` items plus More).
- **Community today.** Customer hub `/loyalty/dashboard/community` (customer only), platform moderation `/platform/network-moderation`, the enrollment/containment code (#562/#566), Feed behind `NETWORK_FEED_ENABLED`. **No business-side Community surface existed.** Business publishing (BDPN) is design documents only (no code); there is no participation aggregate, no business announcements mechanism, no business logo and no verified-business field in the schema.
- **Design system.** Existing workspace theme (navy canvas, mint `#25e9b0`, cyan `#22d3ee`, blue `#3b82f6`, violet `#8b5cf6`, verified in `workspace.module.css`); reused `OverviewPanel`, `MetricCard`, `WorkspaceState`, `Badge`.
- **Flags.** `COMMUNITY_MEMBERSHIP_{JOIN,REJOIN,RESTORE,CLEARANCE}_ENABLED`, `NETWORK_FEED_ENABLED`. No new flag was invented.

## 2. Decisions
| Topic | Decision | Why |
|---|---|---|
| Canonical route | `/dashboard/community` (+ `/participation`, `/posts`, `/insights`) | Existing `/dashboard/<section>` convention |
| Default home | `/dashboard` stays the stable entry and is role-aware: no business → onboarding (stays, never bypassed); cashier → Serve customers (unchanged); unconfirmed → restricted state (unchanged); owner/manager → Community; other management users → Business Overview | Keeps every sign-in path, deep link, session restore and secure `next` untouched; no redirect target points back to `/dashboard` (no loop) |
| Business Overview | Moved intact to `/dashboard/overview` (its content, tests and guards unchanged; "no business" now redirects to the `/dashboard` entry) | "Preserve the dashboard under a Business Overview destination" |
| Navigation | One new top-level item, **Community**, first. Customers and rewards already live inside **Loyalty** (no separate Customers/Rewards destinations exist), so no duplicate entries were invented. Mobile bar = Community, Loyalty, Feedback + More (Overview in More) | Matches the directive's priority within the real structure |
| Who may open it | Existing permissions only: any of `business:manage_settings`, `analytics:view`, `loyalty:accounts:view`, `rewards:manage`, `feedback:manage`, `team:view` (shared list in `shared-types`, used by the page gate **and** the API route). No new permission, no DB change | No privilege escalation; navigation is never the only guard |
| Availability | New read-only `GET /api/v1/community/business/status` returning `{enrollment, feed, publishing}` (`open`/`closed`; publishing always `closed`). Business-wide managers only; tenant-resolved; no customer, membership, consent, points or tenant data; writes nothing | The page must state the real rollout, not guess. Unreadable → "Status unavailable" (never open) |
| Participation / My Posts / Insights | Explicit unavailable states (no numbers, no inputs, no buttons, no API calls) | No approved aggregate service (BCOMM-02), no business publishing (BCOMM-03), no analytics (BCOMM-05) |
| Announcements | Omitted | No existing mechanism; the directive forbids building one |
| Business logo / "verified" | Business name only | No such field exists; nothing invented |
| Database | **None.** No migration | Pure routing/UI plus one read-only route |

## 3. Safety properties (all tested)
Opening the hub enrolls nobody, records no consent, publishes nothing, changes no points, balance or flag, and sends no write request (browser test asserts zero non-GET requests). Every Community page and the layout run their own server-side gate (counter staff → Serve customers; unconfirmed → unavailable; view-only → forbidden; no business → `/dashboard`). The API route refuses view-only staff, branch-scoped managers, foreign owners, outsiders and anonymous callers. Pending-deletion customers are not touched: the hub reads no customer data. The explainer contains no legal terms, policy version, consent wording or approval claim.

## 4. Verification
Unit/integration/browser results are in the BCOMM-01 pull request. Browser acceptance (real Chromium, synthetic owners): desktop, mobile, keyboard, secure return URLs, onboarding not bypassed, French/Spanish/Arabic with right-to-left, no write requests, no console errors on the Community pages.

## 5. Proposed future workstreams (labels only; reconcile with Community Hub/BDPN before adopting)
- **BCOMM-02** privacy-preserving participation analytics (aggregate only, small-group suppression; needs an approved aggregate service and a decision on the minimum group size).
- **BCOMM-03** business publishing and content management (reuses the BDPN design; needs a flag, moderation path and legal terms).
- **BCOMM-04** audience distribution, business discovery and authorized cross-network engagement.
- **BCOMM-05** engagement analytics and customer-acquisition attribution.
- **BCOMM-06** integrated moderation, security and final acceptance.
Not started; none is implemented by BCOMM-01.
