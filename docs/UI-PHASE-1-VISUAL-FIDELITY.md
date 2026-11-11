# UI Phase 1 — Visual fidelity (authenticated workspaces)

Presentation-only change. No API, database, auth, Stripe, migration or financial behaviour was touched.

## What changed
- **Theme scope**: `data-ws-theme="dark|light"` on the workspace root (`WorkspaceThemeRoot`), also exposed via context so portalled dialogs re-apply it. Dark is the default; the light token set is complete and preserved (nothing selects it yet). Tokens (`--ws-*`) live in `app/globals.css`; Tailwind neutral/brand/accent/status variables are remapped inside the dark scope, `bg-white` surfaces become themed surfaces except `data-keep-light` (QR code box, switch knob). Public pages (landing, login, feedback, legal, support) are outside the scope and unchanged.
- **Palette**: navy canvas `#031824`, emerald mint `#25E9B0` primary, cyan `#22D3EE` focus/secondary, blue and violet as supporting metric accents (card order: mint, cyan, violet, blue).
- **Navigation**: desktop sidebar kept. Below 1024px: bottom bar with the first four destinations + **More**. Business: Home, Feedback, Loyalty, Analytics. Platform: Overview, Directory, Audit log, Billing. Customer: Home, QR, Settlements (+ More). Every other link and the utilities (logout, install) live in the More sheet: a modal dialog with focus move/trap, Escape/backdrop/close dismissal and focus restore; logout is pinned below the scrolling list so it stays on screen on short displays.
- **Dashboard**: real API metrics unchanged; added a grounded sentiment summary (counts computed from the same trend data), ICU plural labels (en/fr/es/ar) for branch/point/visit/feedback counts, explicit forbidden/unavailable states unchanged. **Branch filter** shown only when the caller has >1 branch; it narrows only the sentiment trend and the two feedback previews (the API branch-scopes and re-authorizes these). Loyalty and branch counts are business-wide and the page says so. A branch id not in the caller's own branch list is never forwarded and is reported as unavailable.

## Material deviations from the reference mockups (with justification)
1. **Only ECHO_4 is dark** — there is no dark mockup for the business overview, so dark business/customer/platform screens are derived from ECHO_4 plus the production landing identity.
2. **Mockup KPIs/credits/charts not reproduced** where no API data exists (directive: no invented figures, credits or capabilities). Metric cards keep the four real KPIs the page already had.
3. **No decorative imagery/illustration panels** from the mockups; no new assets were created.
4. **Customer and platform bottom bars have 3–4 primary tabs plus More**, not Home/Feedback/Loyalty/Analytics, because those roles have no such destinations.
5. **Public surfaces stay light** (landing, auth, QR feedback, legal, /support) to preserve the landing page and existing flows.
6. **Light mode is not user-selectable** in this phase (token scheme only).
7. `platform-mobile-nav.tsx` (unused legacy component with its own test) was left untouched.

## Verification (local, development only)
See the PR completion report. Contrast of every text/surface token pair in both themes is asserted by `workspace-theme.test.tsx` (WCAG AA 4.5:1).
