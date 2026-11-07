# DEV-31 — Retry Classifier Metamorphic Invariants

**Status:** development-only tests, no runtime integration.

## Baseline

DEV-30 PR #254 is merged. DEV-31 starts from authoritative main.

## Scope

- A rejected-before-record retry at unchanged visible count preserves classification.
- Once an acknowledgement is lost, uncertainty persists unless duplicate observation takes precedence.
- Duplicate-observed classification is absorbing for valid extensions.
- The disposable correlation harness agrees with the pure classifier on synthetic prefixes.
- Classification does not mutate caller history, rejects unapproved metadata, freezes results and never grants financial authority.

These checks do not prove durable custody, settlement, exactly-once semantics, tenant authority or provider behavior. No Stripe calls, storage, routes, migrations, production wiring or deployment.

## Review gates

Require exact-head CI, GitHub mergeability and independent security/architecture review before owner merge. Do not auto-merge, deploy or advance to DEV-32.
