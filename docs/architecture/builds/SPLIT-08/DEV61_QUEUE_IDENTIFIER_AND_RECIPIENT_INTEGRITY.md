# DEV-61 — Queue Identifier and Notification Destination Guardrails

**Authorization:** Development only. No tenant access grant, token, schema, provider, billing or financial modification.

## Baseline finding
DEV-46 accepted any 1–256 character non-whitespace string as an identifier and accepted nonempty notification destinations up to 2,048 characters, including embedded CR/LF, tab and other control characters. These inputs are untrusted JSON, even though normal producers use internal database UUIDs and validated recipient addresses.

## Scoped implementation
- Require identifiers to use the existing DEV-51 tenant-selector-compatible alphabet: start with an ASCII letter or digit, followed by ASCII alphanumeric, hyphen or underscore (max 256).
- Apply to business, branch, feedback, user, customer and critical incident IDs at the queue boundary, preserving UUID and existing development fixture identifiers.
- Reject ASCII control characters and leading/trailing whitespace in notification destination addresses before delivery; preserve ordinary email and E.164-looking SMS strings.
- Add adversarial cross-job tests, allowed-input controls, malformed recipient cases, and tests that verify rejected body contents cannot enter DEV-47/48 failure metadata.

## Explicitly unchanged
This is syntactic validation, **not** membership/authorization validation. It does not guarantee email deliverability, prevent duplicate sends, change queue retries or acknowledgments, alter consent rules, create idempotency, or modify financial processing.

**Verification:** Full exact-head CI and owner review before merge; no production action.
