# Echo Grid — UI Phase 2C-1: Loyalty Accounts visual alignment

Development-only continuation after merged PR #345 (Feedback Inbox), starting from authoritative main `68e668811ed08486fd1a836af27ff524ef5bf621`.

## Scope

Align the existing **staff Loyalty Accounts list** and the **shared Loyalty subsection navigation** with the approved Echo Grid dark navy, mint, cyan and violet visual language.

- New `loyalty-visual.module.css` uses existing workspace CSS variables and no new global theme.
- Loyalty accounts render as individually labelled dark glass cards with customer identity, real visit count, actual last-visit time when available, suspension status, and explicitly business-specific points balance.
- Preserve the existing `GET /loyalty/accounts?limit=20` call and business ID, form action for messaging, and `AccountDialog` actions for recording purchases or adjusting points. No additional data reads or action changes.
- Count text explicitly says **accounts on this page**; do not claim the first 20 are the business total.
- Shared Loyalty nav renders accessible 44px pill links; current page identified by longest matching route, all destinations preserved and localized in en/fr/es/ar, including Customer QR and Orphan settlement.
- Keyboard focus uses existing workspace focus token; all classes stay under authenticated workspace presentation.

## Security and product boundaries

No new endpoints, DB queries, credentials, auth, migration, Neon/Cloudflare/Hyperdrive/Stripe changes, new point-award or redemption logic, financial activation, promotion or campaign semantics. Existing business-tenant authorization remains authoritative. No mock/fabricated customer data, synthetic metrics, total member counts or invented actions.

## Verification and acceptance gates

1. Run `pnpm --filter @echo-grid-feedback/web exec vitest run` using the repository-supported test workflow and all web tests.
2. Run web typecheck, ESLint, Next production build and OpenNext Cloudflare build.
3. Verify the 390/820/1440px and Arabic RTL layouts in production mode with nonproduction fixtures; check menu and dialog focus, screenreader labels and touch-target sizes.
4. Verify existing loyalty account purchase/adjust and message actions are unchanged and continue to function, with no financial activation.
5. Compare rendered screenshots against the user's approved Echo Grid dark-mode loyalty reference designs; document differences.
6. Require exact-head hosted CI and independent owner visual review before marking PASS or merging.

**This is Phase 2C-1, not the whole Phase 2C.** Remaining work includes separate review of tiers, rewards/campaigns, redemption, settings, QR and customer loyalty screens. They are not considered completed by this PR.

No automatic merge or production deployment.
