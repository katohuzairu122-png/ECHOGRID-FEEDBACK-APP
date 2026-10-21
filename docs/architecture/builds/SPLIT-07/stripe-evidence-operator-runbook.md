# HETA-01-F1 operator tooling runbook (IMPL-1; nothing here is activated or deployed)

Status: repository code only. These tools are not run by CI against any shared database, never provision a
Cloudflare secret or binding, and never enable capture. `STRIPE_EVIDENCE_CAPTURE` stays unset/`off` until a
separate, owner-authorized rollout (design E.5, stages S1-S3).

## Safety rails common to every command
- Database commands refuse to run unless `--expect-database <name>` equals `current_database()`. Evidence is append-only; a wrong target cannot be undone.
- Key material is written only to new files with mode `0600` (`wx`: never overwritten) and is never printed. Output is JSON with codes, versions and booleans.
- Keys and tokens are read from the environment (`STRIPE_RESTRICTED_READ_KEY`) or files, never from arguments.
- Control events written here record versions, cohorts, custody locations, commit SHA and approval reference. No key and no key-derived value.

## L2 attestation (`pnpm evidence:attest`)
Environment: `STRIPE_RESTRICTED_READ_KEY` (an `rk_` restricted key with read on Account, Events and Webhook Endpoints; an `sk_` key is refused), `STRIPE_ACCOUNT_ID`, `STRIPE_EXPECTED_LIVEMODE` (`true|false`, never inferred), `ATTEST_ENDPOINT_URL` (exact `/webhooks/stripe` URL), `ATTEST_APPROVED_API_VERSIONS` (comma list, owner-approved), optional `ATTEST_REQUIRED_EVENT_TYPES`, `DATABASE_URL`.
Run `pnpm evidence:attest -- --expect-database <name> [--dry-run]`. Exit 0 only on `passed`. Every non-dry attempt is appended as `account_provenance_verified`; a later failed attempt supersedes an earlier pass. Re-run before `L2_MAX_AGE` (default 24 h) elapses or capture preconditions fail with 503.
Open fact P20: how the endpoint object exposes direct versus Connect scope is unconfirmed. The tool fails only on positive Connect evidence (`application` set) and records its basis in the event so the residual risk is explicit.

## Keyring (`pnpm evidence:keyring -- <command>`)
Generate and custody: `generate --cohort YYYY-MM --version v1 --out entry.json` (offline, 0600). Then `record-generated --cohort C --version V --locations worker_secret,primary_escrow --expect-database NAME` appends the custody inventory (`kek_generated`). A KEK must not exist in the database, repository, CI, logs, chat, backups or any unlisted location.
Assemble: `assemble --entry a.json --entry b.json --at <ISO> --out keyring.json` validates with the Worker's own loader (current active KEK plus runway of at least one next cohort). The operator, not this tool, places the value as the `EVIDENCE_KEK_KEYRING` Worker secret.
Rotation (two phases; the Worker never lacks a usable KEK for the cohort):
1. `rotate-phase1 --keyring k.json --entry new.json --out k1.json` adds the new KEK INACTIVE; deploy k1 to the Worker.
2. `rewrap --cohort C --from V1 --to V2 --old-entry old.json --new-entry new.json --expect-database NAME` verifies (dry run); add `--apply` to insert the re-wrapped row (same DEK, equal fingerprint) and a versions-only `kek_rotated` event.
3. `rotate-phase2 --keyring k1.json --cohort C --from V1 --to V2 --expect-database NAME --out k2.json` removes the old entry and activates the new one, only if the remaining keyring unwraps the same DEK. Deploy k2.
Rotation does not re-encrypt payloads and does not protect them if the DEK was already leaked.

## Not provided here
Reconciliation, backfill and the forensic reader (next block); the destruction procedure and its evidence package (design C.6, human steps); any Cloudflare, Stripe or Neon configuration; the external watchdog host, its read-only role and its alert channel (H15).
