# Cloudflare runtime verification (CF-READINESS-2)

**No Cloudflare configuration was modified. No secret value was read or printed.**

## 1. Exact flag names (from source, not guessed)
Defined in `apps/api/src/config/env.ts` and read only where stated:
| Name | Read by | Default when absent | Invalid value |
|---|---|---|---|
| `COMMUNITY_MEMBERSHIP_JOIN_ENABLED` | Join gate | disabled | disabled (503) |
| `COMMUNITY_MEMBERSHIP_REJOIN_ENABLED` | Rejoin gate | disabled | disabled (503) |
| `COMMUNITY_MEMBERSHIP_RESTORE_ENABLED` | Restore gate | disabled | disabled (503) |
| `COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED` | platform clearance gate | disabled | disabled (503) |
| `COMMUNITY_MEMBERSHIP_PILOT_REQUIRED` | pilot eligibility | pilot mode off | eligibility required (stricter) |
| `NETWORK_FEED_ENABLED` | Feed and moderation routes only | Feed hidden/404 | disabled |
Only the exact string `"true"` enables a gate. Missing/invalid behavior is covered by tests (`community-membership-controls*`, `community-pilot-eligibility*`).

## 2. What the repository proves (and what it does not)
- None of the six names appears in any `wrangler*.toml`, `.dev.vars*` or workflow in this repository, so a deployment from this source sets none of them. **This is repository evidence only; it is not proof of what is configured on the deployed Workers** (a value can be set in the dashboard or by `wrangler secret`/vars outside the repository).
- Environments are separate Workers: production `echo-grid-feedback-api`, `echo-grid-feedback-web`, `echo-grid-feedback-cashier`; staging `echo-grid-feedback-api-staging`, `-web-staging`, `-cashier-staging` (Workers list, read-only).
- The API Worker's last modification (2026-11-24T22:18Z) matches the production deploy run `45496884991`.

## 3. Verification limitation (recorded exactly)
The Cloudflare tool available in this session returns only a Worker's name and id; it does not return variables, secrets or bindings. **Deployed values, and staging-versus-production differences, are therefore NOT VERIFIED here.** No CLI credential for Cloudflare exists in this environment.

## 4. Exact read-only verification for the Owner or release operator
For each of the six Workers that serve the API/web (production and staging):
1. Dashboard: Workers & Pages → the Worker → **Settings → Variables and Secrets**. Confirm that none of the six names above is present. (Secrets show names only; variables show values.)
2. Or CLI, read-only: `npx wrangler deployments status --name echo-grid-feedback-api` and `npx wrangler versions view <version-id> --name echo-grid-feedback-api` list the bindings of the active version (variable values, secret names). Repeat with `--env staging` Workers by name.
3. Record, per Worker: the six names present/absent, the active version id, and the date. Expected today: all absent (Community disabled, pilot mode off, Feed hidden).
4. Re-run after any deployment, and before any activation decision.
Do not paste secret values anywhere.

## 5. Effective runtime defaults (from tests)
All absent → every enrollment operation answers 503 `COMMUNITY_MEMBERSHIP_OPERATION_DISABLED`, `getOffer` reports activation unavailable, reads and Leave still work, Feed routes are generic 404, pilot mode is off (and irrelevant while gates are off).
