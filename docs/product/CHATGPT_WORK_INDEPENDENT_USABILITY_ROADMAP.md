# CHATGPT WORK — Independent Usability Workstream (WORK-UX-01)
Status: PROPOSED ROADMAP / OWNER IMPLEMENTATION AUTHORIZATION REQUIRED
Prepared: 2026-11-15
Source: docs/product/ECHO_GRID_ROADMAP.md (working roadmap updated 2026-11-13); verify authoritative main and code before each block.
Owner: ChatGPT Work (separate from Claude Code cashier security, BDPN D-18, customer auth, rewards, and platform identity).

## Scope and rationale
The roadmap lists three unstarted, user-facing usability fixes and a customer Messages error recovery gap. They can be grouped for parallel, isolated development while avoiding the ongoing cashier security and staging track. This document is a work queue, not evidence that the gaps remain in latest code or that changes are authorized.

## Repository-evidenced gaps
- WORK-UX-01A: Business signup page missing Echo Grid background watermark (roadmap section J).
- WORK-UX-01B: Business form builder still exposes Form name, Key, Question, Type, Required without a simplified quick-setup workflow (section J).
- WORK-UX-01C: Feedback inbox branch dropdown loses other selected filters (section J).
- WORK-UX-01D: Customer Messages page still shows a whole-page error rather than inline retry (section E). Root cause of original error is not confirmed; per-customer limiter was merged in #398. Do not conflate UI recovery with a server-side fix.

## Group W0 — Inventory and conflict gate (read-only)
- Inspect current main, open PRs, exact code routes, components and tests for A–D.
- Determine whether each is already fixed, in progress elsewhere or conflicts with a concurrent branch.
- Verify design tokens, mobile navigation, i18n (including Arabic RTL), accessibility and existing user flows.
- Identify owner decisions and classify each group as READY, BLOCKED or ALREADY COMPLETE.
- No changes to existing security, customer auth, cashier allow-list, BDPN, loyalty ledger, financial activation or infra.

## Group W1 — Business onboarding polish (after W0)
W1A: Add consistent Echo Grid watermark/background to business signup using existing visual assets/tokens; no auth behavior change.
W1B: Simplify business-side form builder quick path without changing persisted form semantics or validation. Preserve existing advanced settings and API contracts.
Deliverables: independently reviewable UI changes, responsive/accessibility tests and snapshots where supported.

## Group W2 — Feedback inbox filter persistence (after W0; parallel with W1)
W2A: Preserve selected category, urgency and branch filters when changing any one filter.
W2B: Test URL/state serialization, reset, pagination, back/forward and empty results as supported by existing implementation.
No changes to tenant/branch authorization or backend query semantics unless separately authorized.

## Group W3 — Customer Messages error recovery (after W0; parallel with W1/W2)
W3A: Replace whole-page error for recoverable message-fetch failures with accessible inline error/retry state; preserve existing error boundary and authentication redirects.
W3B: Tests for 401/403 (do not retry unauthorized), 429 (respect rate limiting), 5xx/network failures, duplicate send prevention and stale data. Do not hide persistent errors.
No limiter/auth changes, message data exposure, notification sends or delivery-provider changes.

## Group W4 — Integration and owner handoff (after owner merges W1–W3)
- Verify exact merged main SHA, typecheck, relevant tests, mobile/RTL/accessibility, regression paths.
- Report staging requirements, but do not deploy without explicit authorization.
- Produce consolidated readiness report, rollback considerations and owner release decision.

## Dependencies
W0 -> [W1, W2, W3 in parallel] -> W4.
Work on separate branches and draft PRs. Each group has its own exact-head CI and completion report. Stop after each group pending owner instruction.

## Required evidence per group
- Authoritative main SHA; exact files/route inventory; PR collision check.
- Before/after behavior and acceptance criteria; unit/component tests, typecheck, lint, hosted CI.
- Tenant, auth, i18n, RTL, accessibility, mobile, error/retry behavior as applicable.
- Branch/head SHA, draft PR, changed files, risks, remaining decisions and next owner action.

## Hard boundaries
- No cashier/staff auth, CLIENT_ATTRIBUTION_SECRET, throttling, staging Workers, Neon/Cloudflare resources, migrations or production.
- No BDPN D-18 / PR #440, Community promotion, loyalty/reward monetary logic, PLATFORM-IDENTITY-01 or financial activation.
- No PR merges. No live customer data or credentials in chat or repository.
- Current WEB-1102 release restrictions remain in force. No deployment without separate approval.
- Existing locked architecture governs; stop on conflicts rather than expanding scope.

## Priority
W0 first; W2 is the smallest independently scoped implementation candidate if still incomplete. W1 and W3 may be parallelized only after W0 confirms no shared-file or feature conflicts.
