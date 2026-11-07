# DEV-63 — Exclusive Staff/Customer Notification Identity

**Authorization:** Development only. No schema, token, authorization role or provider changes.

## Verified defect
`NotificationService.notify()` said it required exactly one of staff `userId` and customer `customerId` but checked only that at least one existed. If both were passed, `resolveAddress()` prioritized the user while the notification queue record still carried both identities.

## Scoped remedy
- Fail closed before any repository access if neither or both recipient IDs are supplied.
- Accept existing exactly-one staff or exactly-one customer paths.
- Regression tests prove dual identity never queries repositories or submits messages and single-identity paths continue normally.

## Limitations
This is a call-contract invariant; it does not replace business-scoped membership, user/customer authentication, or a database constraint.

**Gate:** Exact-head GitHub CI and independent review before merge.
