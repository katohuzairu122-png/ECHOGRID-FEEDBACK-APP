# BCOMM-02 — Privacy-protected participation totals (business Community hub)

Status: IMPLEMENTED — VALIDATION PENDING (hosted CI). No migration. No control activated. Baseline: main `1af1d5b`.

## What it adds
`GET /api/v1/community/business/participation` (business-wide managers only; same gate as `/status`) returns three server-suppressed totals for the caller's own business: active loyalty customers (`eligible`), how many currently hold an `active` Community membership (`participants`) and the whole-percentage `ratePercent`. The Participation tab and the Home summary render exactly that answer. Read-only: one aggregate SELECT; `Cache-Control: no-store`.

## Privacy rules (Owner-approved minimum group size 10, 2026-11-25)
- A figure is shown only for a group of at least `COMMUNITY_AGGREGATE_MIN_GROUP_SIZE` (default 10; configuration can only raise it, never below 10; any non-integer value falls back to 10; cap 1000).
- Participants are also hidden when the non-participants would be a small group (no disclosure by subtraction); the rate is shown only when both figures are.
- A zero is never displayed as `0`: small groups, including empty ones, read "Hidden: small group".
- Only counts leave the database; no customer id, name, contact, points or consent field is selected. Only the business's own active, non-deleted loyalty accounts are counted; other businesses' customers never enter the query.
- Failure of the read, or any answer outside the documented shape, renders "Not available yet" — never an estimate.

## Verification
API unit (suppression, boundaries, clamping), PostgreSQL integration (tenant isolation, active/suspended/deleted/left filtering, group-size configuration, authorization matrix, read-only fingerprint, mutation check that removing the business filter fails 4 tests), web unit (parser fail-closed, page states), Chromium (desktop/mobile/fr/es/ar). Control `COMMUNITY_AGGREGATE_MIN_GROUP_SIZE` is not set in any config.

## Still open
Insights (BCOMM-05 attribution analytics), publishing (BCOMM-03), distribution (BCOMM-04) and moderation/acceptance (BCOMM-06) are unchanged and remain proposed.
