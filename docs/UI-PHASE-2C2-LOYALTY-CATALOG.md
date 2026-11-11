# Echo Grid — UI Phase 2C-2: Staff loyalty tiers and rewards catalog

Status: **Development only — independently reviewable draft**.

## Baseline and dependency
- Baseline authoritative main: `68e668811ed08486fd1a836af27ff524ef5bf621` (merged PR #345).
- Phase 2C-1 (PR #346, Accounts + shared Loyalty navigation) is open, draft, mergeable and has 25/25 hosted checks green.
- **This block is independent of PR #346.** It changes separate files, does not import Phase 2C-1's new modules, and can be tested separately. Recheck current main and merge compatibility after PR #346 merges.

## Owner design objective
Faithfully carry the approved Echo Grid dark authenticated workspace (navy #031824, mint #25E9B0, cyan, violet) through the existing staff Tiers and Rewards Catalog screens. Use existing Phase 1 workspace CSS tokens rather than a parallel palette or generic white cards.

## Implementation scope
- Add reusable `LoyaltyCatalogCard` presentation component, scoped `loyalty-catalog.module.css`, and regression tests.
- Tiers: show actual configured name, minimum points and optional benefits, sorted by actual threshold; preserve existing Create/Edit/Delete dialogs and functions.
- Rewards: show actual name, configured status (active/paused/inactive), nullable points cost only when present, optional description, and existing Dashboard/Edit/Activate/Deactivate/Resume/Delete controls.
- Preserve `GET /loyalty/tiers`, `GET /loyalty/rewards`, `GET /branches` with the same server-resolved business ID. Keep existing reward-branch authorization and dialog options.
- Use native header/section/list/heading semantics, responsive cards, meaningful semantic status badges, visible focus and 44px action targets.
- Preserve existing empty-state content and i18n (en/fr/es/ar) — no hardcoded new labels.
- No mock metrics, fabricated balances, new inventory, campaign, survey, credit, or settlement functionality.

## Strict restrictions
No API, DB, migration, authentication, tenant/RBAC, Neon, Hyperdrive, Cloudflare infrastructure, Stripe, financial authorization, loyalty ledger, customer rewards, or landing-page modifications. No unrelated changes. No merge or production deploy.

## Verification still required
1. Hosted exact-head CI, Web typecheck, ESLint, unit/regression suite, Next production build and OpenNext Cloudflare build.
2. Production-build browser comparison with approved Echo Grid designs at 390px, 820px, 1440px; check nonempty and empty catalog states, mobile action wrapping, and RTL Arabic.
3. Test that Create/Edit/Delete tier actions and Create/Edit/Status/Delete reward actions remain operational; verify no double-submission or unintended mutation.
4. Independent owner review and visual acceptance before marking final PASS or merging. These validations are not asserted complete by the creation of this development branch.

Remaining separate Phase 2C work: staff redemption, QR/settings, rewards campaign detail and customer loyalty screens. Financial activation remains NO-GO.
