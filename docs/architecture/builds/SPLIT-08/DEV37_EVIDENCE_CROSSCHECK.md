# DEV-37 — Offline Integration Evidence Cross-Check

**Development-only.** Builds on DEV-36's deterministic phase dependency plan.

`validateDev37Evidence({baselineSha,statuses,evidence})` rejects a claimed `PASS` without a corresponding nonsecret phase evidence reference, a PASS without satisfied dependencies, duplicate evidence, references for nonpassing phases, and evidence from a different baseline SHA. Run `node --test tools/dev37-evidence-crosscheck.test.mjs`.

This validator **does not** inspect GitHub, Cloudflare, Neon or Stripe, authenticate evidence references, execute tests, run migrations, or authorize financial activity. Its `OFFLINE_CROSSCHECK_PASS` verdict means only that the caller-supplied record is internally consistent. An independent reviewer must verify source artifacts and environment isolation before relying on any result.

DEV-37 is stacked on DEV-36 PR #260. Retarget after DEV-36 merges and rerun exact-head CI. All integration, migration, production and deployment operations remain outside this block and require separate explicit authorization.
