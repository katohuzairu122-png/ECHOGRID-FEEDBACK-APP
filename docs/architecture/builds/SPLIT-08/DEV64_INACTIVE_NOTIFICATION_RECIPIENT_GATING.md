# DEV-64 — Inactive Recipient Notification Guard

**Authorization:** Development only. No database migrations, billing, settlement, loyalty/credit or deployment operations.

## Verified defect
`NotificationService.resolveAddress()` accepted any nondeleted staff or customer returned by `findById`, regardless of account status. A staff user with a surviving active business-role grant but status `invited`, `suspended` or `deactivated` could be included in business-wide notifications; a suspended customer could also receive notifications.

## Scoped remedy
- Before computing addresses and enqueueing messages, require a staff or customer record with status exactly `active`.
- Skip missing or inactive recipients without generating provider messages or reading notification preferences.
- Preserve the existing routing, business settings, SMS cap, consent/preferences and successful active-account paths.
- Regression matrix covers invited/suspended/deactivated staff, suspended customers, deleted/missing identities and active controls.

## Explicit limitation and future decision
This is a **producer-time** active-account guard. The existing notification queue job carries a fully resolved recipient and does not recheck account status at delivery time. If a user is suspended after enqueue, an already queued message may still deliver. Blocking such pending sends requires a separately reviewed runtime-authentication/revocation architecture decision, not an implicit change to the frozen queue contract.

**Gate:** Full exact-head CI and independent owner review before merge. No production certification claimed.
