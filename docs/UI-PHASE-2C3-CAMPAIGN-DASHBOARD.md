# Echo Grid — UI Phase 2C-3: Reward Campaign Dashboard visual alignment

**Status:** Development-only; owner acceptance and exact-head hosted CI required.

## Verified starting point

- Baseline authoritative main: `dc62cd3c0f5a1abc19ef24be4915faa69a44cdc2` (merged Phase 2C-1 PR #346).
- Phase 2C-2 PR #347 (tiers and rewards catalog) was open, draft and mergeable with 25/25 successful hosted checks at the start of this block.
- Phase 2C-3 is **independent** of #347: this branch changes only the reward **detail** route and new route-local presentation files, not the catalog pages or their shared component. Recheck main/PR mergeability if #347 merges.

## Scope

Restyle existing authorized staff campaign dashboard at `/dashboard/loyalty/rewards/[id]` to the approved Echo Grid dark navy / mint / cyan / violet design system.

1. Preserve existing `GET /loyalty/rewards/:id/dashboard` with its server-resolved `businessId` and existing API error behavior (including 404).
2. Keep budget bar and labels grounded in API `budgetTotal` and `budgetUsed`; show non-applicable and no-cap states exactly as before. Do not estimate missing budgets, and do not misrepresent available credit or financial authorization.
3. Show real `outstandingCount`, `redeemedCount`, and `redemptionRate` in styled metric cards. A null rate is displayed as an em dash plus the existing translated no-data explanation, **not 0%**.
4. Preserve API-resolved branch scope, configured reward terms, localized currency/date formatting, and status badge (active/paused/inactive).
5. Preserve the existing staff **read-only** customer reward preview. No customer redemption form, staff redemption button, or other new action.
6. Use route-local CSS on Phase 1 workspace semantic `--ws-*` variables, accessible headings, `<dl>` counts/labels, visible keyboard focus, responsive breakpoints and reduced-motion.
7. Reuse existing translations without adding or hardcoding new UI strings.

## Excluded by design

No changes to APIs, authentication, permissions, tenant/branch scoping, customer loyalty, business point ledgers, Stripe, Neon, Hyperdrive, Cloudflare infrastructure, database schema, financial activation, landing or login pages. No invented fraud metrics, settlement statistics, reservations, credits, balances, or campaigns.

## Verification and owner acceptance gates

- Focused unit tests for semantic campaign metric rendering and honest null-rate handling.
- Hosted CI on the **final** exact PR head, Web typecheck, ESLint, full tests, Next production build, OpenNext Cloudflare build.
- Browser checks with authorized nonproduction fixtures at 390px mobile, 820px tablet and 1440px desktop, including Arabic RTL and reduced motion.
- Verify budget null/no-cap/bounded variants, null vs populated redemption rate, inactive/paused badges, branch and terms display, and read-only preview.
- Review screenshots against owner-approved dark campaign/rewards mockups and record deviations.
- This PR must remain draft until independently reviewed; no merge/deployment or progression into redemption/payment behavior.

**Financial activation remains NO-GO.**
