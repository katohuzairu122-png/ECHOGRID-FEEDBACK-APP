# DEV-73 — Signed Business and Customer QR Claim Integrity

**Authorization:** Development only. Cryptographic verification and downstream identity safety; no rotation/deployment action.

## Verified gap
Business and customer QR verification checked the JWT signature, expiry and token purpose, then relied on an unchecked TypeScript assertion for identifier, nonce, signature-version and time-claim shapes. A cryptographically signed but malformed token could therefore reach row resolution with missing or wrongly typed identity fields.

## Change
- A shared structural predicate validates identifiers, nonce, signature version and safe integer issue/expiry timestamps, requiring expiry later than issue.
- Business QR verification also validates business/branch identifiers and optional campaign reference.
- Customer QR verification validates its identity and token purpose.
- Preserve legacy `qr_feedback` tokens, HS256, the previous-secret rotation window, short customer TTL and existing 365-day physical business QR TTL.
- Adversarial signed-payload tests reject missing identifiers, invalid scopes, empty nonces, unsupported versions and malformed claim times.

Nonce presence is not replay detection, a signed QR is not proof of a purchase, and valid signatures never authorize points/loyalty/settlement by themselves. Full exact-head CI and owner review required.
