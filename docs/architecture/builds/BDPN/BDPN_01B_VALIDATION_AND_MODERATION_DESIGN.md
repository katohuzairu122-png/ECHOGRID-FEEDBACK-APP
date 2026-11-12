# BDPN-01B — Business Profile Validation and Moderation Authority Design

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY. No permission is seeded, no role is changed, no route, service, schema or
shared type is created. Nothing here authorizes implementation, a migration, a notification, marketing, a merge or a deployment.**

- Baseline: `origin/main` @ `b2f85ac097e5c3b945dc586df046513494525705`
- Inputs (merged): spec, security document, sequence, decision record, 01A. This block also relies on 01C (open PR #365) only for
  the normalization function (its section 5.2).
- **Gated item:** the moderation reason codes and content rules depend on the owner approving the **interim content policy**
  (`BDPN_01_INTERIM_CONTENT_POLICY_DRAFT.md`, decision D-16). That policy is a draft, so everything here that depends on it is marked
  **PENDING D-16** and is defined as a code-owned constant that the owner can change without a schema change.
- "Proposed" is a design choice for owner review. "OPEN" is a question this block surfaces and does not decide (section 11).

## 1. Decisions applied

| Decision    | Effect                                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D-02        | Business permissions `profile:edit` and `profile:submit`, business-wide, granted to Owner and Admin only                                  |
| D-03        | Moderation by **platform administrators only**, through a separate **code-owned** permission `profile:moderate`; support may not moderate |
| D-04        | Submission requires default-locale display name, summary and description, a category on the business, and at least one location row       |
| D-05 / D-07 | No media; one optional https website                                                                                                      |
| D-13        | Re-publish of an unchanged, still-eligible approved revision needs no new review                                                          |
| D-14        | Every edit is a new revision and is reviewed                                                                                              |
| D-15        | No response-time promise; a rejection carries a clear reason; resubmission is the appeal path                                             |
| D-16        | Reason codes and content rules come from the interim policy, PENDING D-16                                                                 |
| D-21        | Manual platform review only; no external identity verification                                                                            |
| D-22        | Moderators may also see the business's team and subscription details, limited as in section 6                                             |

## 2. Field validation rules (the application validator; the database enforces only length and enumerations, per 01A)

All text is **plain text**, Unicode **NFC**-normalized and trimmed. Lengths count Unicode code points, not bytes. Failure returns a
field-level error list (section 5.4). Rules are the **same** for every locale.

| Field                     | Rule                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display_name`            | 2 to 80 characters                                                                                                                                                                                                                                                                                                                           |
| `summary`                 | 1 to 160 characters (required in the default locale at submission)                                                                                                                                                                                                                                                                           |
| `description`             | 1 to 1000 characters; line breaks allowed (at most 20); required in the default locale at submission                                                                                                                                                                                                                                         |
| `website_url`             | Optional. Must parse as a URL with scheme `https`; a host with at least one dot; no userinfo; no non-default port; no IP-address or `localhost` host; at most 2000 characters; the fragment is removed; known tracking parameters (`utm_*`, `fbclid`, `gclid`) are removed; an internationalized host is stored in its ASCII (punycode) form |
| Location `kind`           | `place` or `service_area`                                                                                                                                                                                                                                                                                                                    |
| Location `label`          | 1 to 120 characters                                                                                                                                                                                                                                                                                                                          |
| Location `country_code`   | Exactly two uppercase letters and a member of the ISO 3166-1 alpha-2 list; required for `place`                                                                                                                                                                                                                                              |
| Location `city`, `region` | 1 to 80 characters each; `city` required for `place`                                                                                                                                                                                                                                                                                         |
| Location `street_address` | 1 to 160 characters; only for `place`; only if the business ticks the opt-in                                                                                                                                                                                                                                                                 |
| Locations per revision    | At least 1, at most 10; unique `position`                                                                                                                                                                                                                                                                                                    |
| Translations per revision | At most 4 (one per supported locale)                                                                                                                                                                                                                                                                                                         |

**Characters rejected in any text field:** control characters (Unicode category Cc); format characters (Cf) **except** the zero-width non-joiner
and joiner (U+200C, U+200D), which Arabic and other scripts need; the bidirectional override and isolate characters (U+202A to U+202E and
U+2066 to U+2069); unassigned and private-use code points; lone surrogates. **Content patterns rejected in `display_name`, `summary`,
`description` and location text:** a URL (`http://`, `https://`, `www.`), an email address, and a phone-like run of seven or more digits
(spaces, dots and dashes between digits included). A website belongs in `website_url` only. Digits in ordinary prose (for example a year) remain allowed.

These rules are conservative on purpose: a false rejection costs the business a correction, while a false acceptance puts unreviewed
contact data into a public profile. The pattern list is part of the code-owned validator and is tuned without a schema change.

## 3. Submission completeness (D-04), enforced in the application **and** by the database trigger from 01A

A `draft -> submitted` change succeeds only if all of these hold, otherwise **422** with the missing items listed:

1. the business has a category (`businesses.category_id`);
2. the default-locale translation has `display_name`, `summary` and `description`;
3. there is at least one location row, valid under section 2;
4. every field passes section 2;
5. the content digest has been computed and stored (section 4);
6. no other revision of this business is `submitted`, and the business is `active`.

## 4. Content digest and normalization (frozen here, to be implemented with test vectors)

### 4.1 Digest

The digest binds an approval to exactly what the moderator saw (threat T-04).

1. Build the content object `{ website_url, translations[], locations[] }`.
2. Convert **every string to Unicode NFC**.
3. Sort `translations` by `locale` ascending and `locations` by `position` ascending.
4. Serialize as JSON with **object keys sorted lexicographically at every level**, no whitespace, absent optional values as `null`, non-ASCII
   characters written as themselves (not `\u` escapes), encoded as UTF-8.
5. The digest is the lowercase hexadecimal SHA-256 of those bytes.

**Test vector 1** (checked while writing this document):

```text
canonical bytes (one line):
{"locations":[{"city":"Kuwait City","country_code":"KW","kind":"place","label":"Salmiya","position":0,"region":null,"street_address":null}],"translations":[{"description":null,"display_name":"بدي كافيه","locale":"ar","summary":null},{"description":"Specialty coffee and pastries.","display_name":"Buddy Café","locale":"en","summary":"Coffee shop in Salmiya"}],"website_url":"https://example.com/"}

sha-256 = 61ae1a5b3e0d29308bb0f50d6abcd70edad98836cbee7765b0c6034568de6d33
```

**Test vector 2:** the same content with "Café" typed in the decomposed form ("Cafe" plus U+0301) must produce the **same** digest, which proves
NFC normalization happens before hashing. Any implementation that does not reproduce both vectors is wrong.

The approval request carries the digest the moderator reviewed. The service recomputes the digest from the stored revision and refuses on any
mismatch with `PROFILE_DIGEST_MISMATCH`.

### 4.2 Search normalization (`display_name_normalized`, amendment A-1 in 01C)

Unicode NFKC, then case folding, then removal of combining marks, then collapse of whitespace runs to one space. Properties to prove with vectors in
`en`, `fr`, `es`, `ar`: accents are removed ("Café" and "cafe" match); Arabic short-vowel marks are removed; Arabic base letters are **not** altered;
the result is stable (applying the function twice gives the same value). One illustrative pair, checked with a general-purpose Unicode library
(**not** the reference implementation): " Buddy Café " normalizes to `buddy cafe`. The reference function and its vectors are an implementation
deliverable; the stored value is frozen with the revision.

## 5. Transition service contract

One service owns every state change from 01A section 4.1. Business routes and platform routes are thin callers; no other code writes the
state or pointer columns. Every operation is **one database transaction** that locks the publication row, validates, writes, and writes the audit row.

### 5.1 Operations

| Operation        | Caller                              | Inputs                                                               | Preconditions (besides the 01A guards)                                                                      | Result                                                                                     |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `saveDraft`      | Business (`profile:edit`)           | content, optional `expectedVersion`                                  | Business `active`; at most one open draft (created on first save); the caller's tenant equals the profile's | Draft saved; `version` bumped                                                              |
| `submit`         | Business (`profile:submit`)         | `revisionId`, `idempotencyKey`                                       | Section 3                                                                                                   | Revision `submitted`; digest stored; business sees "in review"                             |
| `withdraw`       | Business (`profile:submit`)         | `idempotencyKey`                                                     | State is `published`                                                                                        | Publication `withdrawn`; pointer kept                                                      |
| `republish`      | Business (`profile:submit`)         | `idempotencyKey`                                                     | State is `withdrawn`; pointer revision still `approved`; eligibility predicate passes (D-13)                | Publication `published`                                                                    |
| `approve`        | Platform admin (`profile:moderate`) | `revisionId`, `digest`, `idempotencyKey`                             | Revision `submitted`; digest matches; reviewer is not the submitter; business `active`                      | Revision `approved`; pointer set (previous revision `superseded`); publication `published` |
| `reject`         | Platform admin                      | `revisionId`, `reasonCode`, optional internal note, `idempotencyKey` | Revision `submitted`; reason from the code-owned list (PENDING D-16)                                        | Revision `rejected`                                                                        |
| `suspend`        | Platform admin                      | `businessId`, `reasonCode`, internal note, `idempotencyKey`          | State is not already `suspended`                                                                            | Publication `suspended`                                                                    |
| `liftSuspension` | Platform admin                      | `businessId`, internal note, `idempotencyKey`                        | State is `suspended`                                                                                        | Publication `unpublished`; **not** auto-republished                                        |

### 5.2 Concurrency and idempotency

- Every operation takes a row lock on the publication record (`SELECT ... FOR UPDATE`) and rejects a stale `expectedVersion` with `PROFILE_VERSION_CONFLICT`.
- `idempotencyKey` (8 to 200 characters, as the Surveys endpoints already use) makes a retry of the **same** operation return the stored result; the same key with
  different inputs returns `PROFILE_IDEMPOTENCY_CONFLICT`. Keys are scoped per business and operation.
- The two partial unique indexes from 01A make a second concurrent `submit` fail even if the lock were bypassed.

### 5.3 Candidate routes (design only)

Business side, following the pattern of the Partner terms routes (`authenticate`, `resolveTenantContext`, `requireBusinessWideAccess`, then `requirePermission`):

| Route                                                                                                                                 | Permission                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /business-profile` (state, live revision, open draft, last rejection reason)                                                     | `profile:edit`                                                |
| `PUT /business-profile/draft`, `POST /business-profile/submit`, `POST /business-profile/withdraw`, `POST /business-profile/republish` | `profile:edit` for the draft; `profile:submit` for the others |

Platform side, following `requirePlatformRole(['admin'])` plus a code-owned permission check (the pattern of `platform/community-permissions.ts`),
re-resolved from the database on every request:

| Route                                                                                                                                            | Permission         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `GET /platform/profile-moderation/queue` and `GET .../revisions/:id`                                                                             | `profile:moderate` |
| `POST .../revisions/:id/approve`, `POST .../revisions/:id/reject`, `POST .../profiles/:businessId/suspend`, `POST .../profiles/:businessId/lift` | `profile:moderate` |

**Impersonation:** every write route above, and every moderation route, refuses a session with `impersonatedBy` set (precedent:
`PARTNER_CONSENT_IMPERSONATION_DENIED` on the Partner terms accept route). A platform administrator acting as a business can read the profile page but cannot submit,
withdraw, approve or suspend.

### 5.4 Errors (proposed codes; statuses available in `AppError`)

| Situation                                                                                        | Status | Code                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| Not signed in / expired                                                                          | 401    | `UNAUTHENTICATED` (existing)                                                                                   |
| Missing permission, branch-scoped user, impersonation                                            | 403    | `PERMISSION_DENIED` (existing) / `PROFILE_IMPERSONATION_DENIED`                                                |
| Unknown business or revision for this caller                                                     | 404    | `PROFILE_NOT_FOUND`                                                                                            |
| Illegal transition, stale version, digest mismatch, second open draft or submission, self-review | 409    | `PROFILE_STATE_CONFLICT`, `PROFILE_VERSION_CONFLICT`, `PROFILE_DIGEST_MISMATCH`, `PROFILE_SELF_REVIEW_DENIED`  |
| Validation or completeness failure                                                               | 422    | `PROFILE_VALIDATION_FAILED` with `details: [{ field, rule }]` (no echo of rejected text beyond the field name) |
| Same idempotency key, different inputs                                                           | 409    | `PROFILE_IDEMPOTENCY_CONFLICT`                                                                                 |

## 6. Permissions and the moderator view (D-02, D-03, D-22)

### 6.1 Permission keys (proposed)

| Key                | Where it lives                                                  | Granted to                 |
| ------------------ | --------------------------------------------------------------- | -------------------------- |
| `profile:edit`     | Business permission catalog (`permissions.seed.ts`)             | Owner, Admin               |
| `profile:submit`   | Business permission catalog                                     | Owner, Admin               |
| `profile:moderate` | **Code-owned** platform permission (not stored in the database) | Platform role `admin` only |

New business permissions need three data steps, all separate from the schema migration: the catalog entry, the default role definitions
(`role-provisioning.service.ts`), and a **backfill** for existing businesses' roles in the established pattern (`role-permissions-backfill.seed.ts`). Owner and Admin
only; Manager and Staff cannot change what the public sees.

### 6.2 What a moderator sees (D-22), limited and audited

For a revision under review, a platform administrator receives a **review bundle**:

- the submitted content exactly as customers would see it, with each translation and the content digest;
- the business's category, status and creation date;
- **team size and the names of the roles that exist** (not individuals), and the **subscription plan name**;
- the history of earlier revisions with their decisions and reason codes.

**Never** included: customer data, loyalty, Community Points or Partner Credit data, billing amounts, payment details, staff names, emails or phone numbers, or any
other business's data. Opening the bundle is itself an audited read. The extra business context (team size, role names, plan name) is read-only and available only to the
holders of `profile:moderate`.

## 7. Moderation queue and reason codes

- **Queue:** `submitted` revisions ordered by `submitted_at` ascending, then revision id. No priority or paid placement. No promised response time (D-15).
- **Reason codes (PENDING D-16):** the list in the interim policy draft: `MISLEADING_CLAIM`, `IMPERSONATION`, `PROHIBITED_BUSINESS`, `PERSONAL_DATA`, `CONTACT_ABUSE`,
  `OFFERS_AND_PRICING`, `HARMFUL_OR_UNLAWFUL`, `OFF_TOPIC_OR_LOW_QUALITY`, `INCOMPLETE`, `LANGUAGE_MISMATCH`, `OTHER`. They are a **code-owned constant**; the database stores
  the value as constrained text (01A) so the owner can change the list without a migration.
- **What the business sees on rejection:** the reason code, translated into `en, fr, es, ar` (wording needs owner approval, decision-record item N-3), and the moderator's
  short note **only if** the moderator marks it as customer-visible. The internal note is never exposed.
- **Appeal (D-15):** the business edits and resubmits; each submission is a new revision.
- **No automatic notification** is sent on submit, approve or reject (ruling R5). Whether to add a **transactional** notice to the business for these decisions is a new event type and is
  OPEN (O-B1).

## 8. Audit evidence

One `audit_log` row per operation in the same transaction (a failed audit write rolls the operation back). Actions: `business_profile.draft_saved`, `.submitted`, `.approved`,
`.rejected`, `.published`, `.updated`, `.withdrawn`, `.republished`, `.suspended`, `.suspension_lifted`, plus `business_profile.review_opened` for the moderator read.
`metadata` holds the revision id, the content digest, the reason code and the actor role. It **does not** hold the internal note text or any profile text.

## 9. Separation of duties and abuse resistance

- The database refuses `reviewed_by = submitted_by` (01A). The service also refuses and returns `PROFILE_SELF_REVIEW_DENIED`.
- A platform administrator who is **also** an Owner of the business cannot approve that business's revision (same check, because the submitter is that user or another member; the
  service additionally refuses when the reviewer holds any role in the business being reviewed: OPEN O-B2 asks whether to apply that stricter rule).
- Business routes require business-wide access, so a branch-limited user cannot publish.
- Rate limits for business writes use the existing authenticated API limiter keyed by user; moderation routes are low-volume administrator routes.

## 10. Test requirements (specified, not written)

1. Validator: a table-driven positive and negative case for every rule in section 2, including each rejected character class, the bidi controls, and the URL, email and phone patterns.
2. Digest: test vectors 1 and 2; reordered input yields the same digest; a one-character change yields a different digest.
3. State machine: each operation's legal path, and each illegal path (approve a draft, approve own submission, withdraw when not published, republish a suspended profile).
4. Digest mismatch aborts approval; a concurrent edit attempt on a submitted revision is rejected.
5. Concurrency: two simultaneous `submit` calls and two simultaneous `approve` calls leave exactly one winner (PostgreSQL 18).
6. Authorization matrix from the security document for every route; impersonation denied on every write.
7. Idempotency: repeat returns the stored result; same key with different inputs conflicts.
8. Audit: one row per operation, none containing profile text or the internal note; failure of the audit write rolls back the operation.
9. Permission seeds and backfill: Owner and Admin gain the two keys in new and existing businesses; Manager and Staff do not.
10. No customer-visible output changes, and no notification, consent or points row is created, by any of these operations.

## 11. Open questions (not decided)

| ID   | Question                                                                                      | Options                                                                      | Author's view                                                           |
| ---- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| O-B1 | Tell the business about decisions through a new transactional notification                    | None (dashboard only, proposed) or a new event type on the existing channels | Dashboard only for v1: a new event type is a notification-system change |
| O-B2 | Stricter conflict rule: a platform admin who holds any role in the business may not review it | Strict (proposed) or only the submitter is barred                            | Strict: closes the "admin who is also a member" gap                     |
| O-B3 | Business sees the moderator's note                                                            | Only when marked customer-visible (proposed), always, or never               | Customer-visible flag keeps internal remarks internal                   |
| O-B4 | Content-pattern strictness (phone-like digit runs, URL and email in text)                     | As in section 2, or looser                                                   | Start strict; loosen with evidence                                      |
| O-B5 | Whether the interim content policy, once approved, is shown to businesses at submission       | Yes (proposed) or only on rejection                                          | Yes: it reduces rejections                                              |

## 12. Owner gate and acceptance

- **Owner gate:** approval of the interim content policy (D-16), and answers to O-B1 to O-B5 where they matter.
- **Acceptance met by this document:** every transition in the spec has an actor, preconditions, error behavior and audit evidence; no business-side operation can publish; the
  moderator authority is a code-owned permission with separation of duties enforced in the database; the digest and normalization rules have test vectors; and nothing introduces a
  notification, consent, marketing, loyalty, Community Points or billing behavior.
- BDPN-01D and 01E are in the same PR for review but **no implementation block is started or authorized by this document**.
