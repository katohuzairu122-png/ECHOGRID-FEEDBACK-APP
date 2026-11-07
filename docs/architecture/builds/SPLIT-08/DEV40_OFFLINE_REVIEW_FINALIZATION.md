# DEV-40 — Offline Integration Readiness Finalization

Development-only. DEV-40 builds on DEV-39 and records a **caller-supplied** review assertion against an exact baseline SHA.

Run `node --test tools/dev40-offline-review.test.mjs`.

A matching baseline, internally consistent DEV-39 report, and affirmative review assertion produce `READY_FOR_SEPARATE_STAGING_AUTHORIZATION`. This is **not** approval to execute. The system does not authenticate reviewer identity, independently verify evidence, call Neon/Stripe/Cloudflare, run tests against infrastructure, execute migrations, or deploy.

A rejected review, missing review evidence, incomplete upstream gate or mismatched SHA blocks or throws. The output always denies staging execution, migration, deployment and financial authority.

DEV-40 is stacked on DEV-39 PR #263 until that PR merges. After merge, retarget to main and verify exact-head CI before owner review. Any isolated staging integration or migration planned for Tuesday 2026-11-10 requires fresh explicit authorization.
