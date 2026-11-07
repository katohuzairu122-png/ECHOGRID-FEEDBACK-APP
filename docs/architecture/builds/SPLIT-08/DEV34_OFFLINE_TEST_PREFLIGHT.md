# DEV-34 — Offline Test Preflight

Development-only, no external service access, no migrations, no deployment.

Run `node tools/dev34-offline-test-preflight.mjs` from the repository root to check required tracked files and pinned pnpm 11.x metadata. Run `node --test tools/dev34-offline-test-preflight.test.mjs` for fail-closed regression tests.

The script intentionally does **not** read secrets, check Neon/Cloudflare/Stripe connectivity, validate database schema, execute migrations, run application servers, or assert operational readiness. A PASS means **only** the static files and package-manager metadata exist.

DEV-34 is stacked on DEV-33 PR #257. Retarget to main after DEV-33 merges and verify exact-head CI. Integration, resource provisioning and migrations are reserved for the separately authorized Tuesday, 2026-11-10 window. Do not interpret this schedule as authorization to execute them.
