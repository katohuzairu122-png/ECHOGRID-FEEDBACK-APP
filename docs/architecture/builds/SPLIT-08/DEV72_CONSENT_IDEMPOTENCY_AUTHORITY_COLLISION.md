# DEV-72 — Consent Grant Idempotency Authority Collision

**Authorization:** Development only. Consent storage identity guard; no schema change, data mutation outside existing consent operations, migration or deployment.

## Verified gap
`ConsentGrantRepository.create` resolved a unique `idempotencyKey` conflict by returning any stored grant using that key without checking customer/business/resource authority. Reuse of a key across a different customer, business, purpose, scope, resource ID/type or consent version could return the wrong grant and be mistaken for valid consent.

## Change
- Fail closed with generic HTTP 409 `CONSENT_IDEMPOTENCY_CONFLICT` unless the stored row matches all grant-authority identity fields.
- Treat absent optional business/resource/scope fields as database null and preserve existing default consent version semantics.
- Preserve successful same-authority idempotent retry, and all existing SQL uniqueness behavior.
- Unit tests cover each identity mismatch without revealing the foreign grant.
- Disposable PostgreSQL tests cover real conflict resolution and cross-customer/business/scope/version denials.

Expiration and variable metadata are not a scope grant; this block does not silently renew or expand stored authority, change status policies, or activate any financial benefit. Exact-head CI and independent owner review required.
