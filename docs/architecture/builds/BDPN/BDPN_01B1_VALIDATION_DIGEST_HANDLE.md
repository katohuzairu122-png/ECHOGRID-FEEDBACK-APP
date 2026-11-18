# BDPN-01B part 1 — content validation, canonical digest, search normalization and handle (implementation record)

**Status: IMPLEMENTED — VALIDATION PENDING (draft PR). Development only. Pure functions and unit tests: no database, no route, no service, no permission, no migration. Nothing calls these functions yet.**

- Baseline: `origin/main` @ `4fd02f87048997874b4d5edd7e6d04cc66560d4d`. Independent of the storage block BDPN-F1 (separate branch from main; nothing here imports the new schema).
- Implements: `BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md` sections 2, 3 (content half) and 4, and amendment A-1 of `BDPN_01C_DISCOVERY_API_DESIGN.md`. Decisions applied: D-04, D-05, D-06, D-07, D-08, D-10, D-14.

## 1. Files

| File | Purpose |
| --- | --- |
| `apps/api/src/business-profile/profile-content.ts` | Field validator and normalizer; submission completeness (content half); website normalization; ISO 3166-1 alpha-2 list |
| `apps/api/src/business-profile/profile-digest.ts` | Canonical JSON and SHA-256 content digest (design section 4.1) |
| `apps/api/src/business-profile/profile-search.ts` | `display_name` search normalization (design section 4.2) |
| `apps/api/src/business-profile/profile-handle.ts` | Opaque 22-character base64url handle generator and format check (D-10) |
| `apps/api/src/business-profile/profile-content.test.ts` | 20 unit tests, including the design's two digest test vectors |

## 2. Behaviour in brief

- Plain text only, Unicode NFC, trimmed, lengths counted in code points. Control, format (except ZWNJ/ZWJ), bidirectional, unassigned, private-use and lone-surrogate characters are refused. A description may keep up to 20 lines.
- URLs, email addresses and phone-like digit runs (seven or more digits, with spaces, dots or dashes between, any script's digits) are refused in names, summaries, descriptions and location text. Ordinary digits in prose are allowed.
- Website: https only, host with a dot, no userinfo, no port, no IP or localhost, at most 2000 characters; fragment and `utm_*`, `fbclid`, `gclid` removed; IDN stored as punycode.
- Locations: `place` or `service_area`; country must be an uppercase ISO 3166-1 alpha-2 code (not auto-corrected); `place` needs city and country; a street address only for a `place` and only with the business's opt-in; 1 to 10 locations at submission; positions are assigned by order.
- Failures are field-level `{ field, rule }` lists and never echo the rejected text.
- Digest: reproduces the design's **test vector 1** exactly (canonical bytes and `61ae1a5b…de6d33`), and **test vector 2** (decomposed and composed "Café" hash the same). Independent of input order; any approved field changing changes the digest.
- Search normalization: NFKC, case folding (including ß), accents removed, Arabic short-vowel marks removed while Arabic base letters (for example hamza-on-alef) are kept, whitespace collapsed; idempotent.

## 3. Deliberately not here

- **Moderation reason codes and any judgement of whether content is allowed** (decision D-16, the content policy, is still an unapproved draft). The validator checks shape, characters and contact patterns only.
- Database-dependent submission rules (category on the business, business `active`, no other submitted revision), transition service, idempotency keys, optimistic version checks, permissions (`profile:edit`, `profile:submit`, the code-owned moderation permission), routes and audit rows. Each is a later block.
- Unification of the locale list with the database schema constants (the storage block is a separate PR; the list is repeated here on purpose and noted in the code).

## 4. Known limits (for review)

- "Unassigned code point" depends on the Unicode version of the JavaScript engine. The Node CI runtime and the Cloudflare Workers runtime may differ by a Unicode release, so a very recently assigned code point could be accepted on one and refused on the other. It never affects a stored digest, because the digest hashes the already-validated text.
- Case folding is `toLowerCase` plus the ß and final-sigma cases, not full Unicode case folding. It is deterministic and sufficient for the four supported locales; the stored value is frozen with the revision, so changing the function later would need a re-normalization decision.

## 5. Verification

API typecheck passes; the new files lint clean; 20 of 20 new tests pass; the API unit suite passes (230 files, 3,662 tests). Hosted CI result: see the PR.
