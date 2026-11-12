# BDPN-01A — Publication Data Contracts and Schema Proposal

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY. No migration file, schema code, shared-type code, journal change or Gate 2
pin is created. Nothing here authorizes implementation, a migration, an endpoint, a page, a notification, marketing, a
merge or a deployment.**

- Block: BDPN-01A (authorized by the owner for design only)
- Baseline: `origin/main` @ `f098920275cd2ecf3eb75357c58ec4e2e987e8ea` (journal: 68 entries, last `0067_customer_preferred_locale`)
- Inputs: `BDPN_01_BUSINESS_PROFILE_DISCOVERY_SPEC.md` (the spec), `BDPN_01_SECURITY_AND_CONSENT_BOUNDARIES.md`,
  `BDPN_01_IMPLEMENTATION_SEQUENCE.md`, `BDPN_01_OWNER_DECISION_RECORD.md` (the decision record, PR #363, still a draft at
  the time of writing; this document applies its answers and must be read with it).
- **Supersession:** this document **replaces** spec sections 2.2 (field contract) and 7 (proposed schema) and the
  revision-status list in spec section 3.1. Where they differ, this document governs. The spec itself is not edited here.
- "Proposed" is a design choice for owner review. "OPEN" is a question this block surfaces and does not decide (section 9).

## 1. Decisions applied

| Decision                                   | Effect on the data contract                                                                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 immutable revisions plus live pointer | `business_profile_revisions` (immutable once submitted) and `business_public_profiles` (publication state and pointer)                                                        |
| D-04 minimum to submit                     | A revision can be submitted only with, in the business's default locale: display name, summary and description, plus a category on the business and at least one location row |
| D-05 no images in v1                       | **No media table** and no media columns in v1                                                                                                                                 |
| D-06 location detail                       | `kind = place` (city and country required, street address optional and opt-in) or `service_area`; **no coordinate columns**                                                   |
| D-07 website only                          | One nullable `website_url` (https). **No public phone or email columns**                                                                                                      |
| D-08 no subcategories                      | No subcategory structure                                                                                                                                                      |
| D-10 opaque handle                         | `profile_handle`: random, unique, never derived from `businesses.id`, slug or time                                                                                            |
| D-11 translated category names             | New `business_category_translations` table; the existing English `name` is the fallback                                                                                       |
| D-12 / D-17                                | No caching and no view tracking, so **no epoch counter and no analytics tables**                                                                                              |
| D-13 / D-14                                | Re-publish keeps the last approved pointer; every edit is a new revision that is reviewed                                                                                     |
| D-19 one new migration after the backlog   | All BDPN-01 tables ship in **one** migration (section 7)                                                                                                                      |
| D-24 plan entitlement                      | **Not in the schema.** Reserved as a read-only term in the eligibility predicate (section 6)                                                                                  |
| D-03 / D-22                                | Moderation authority is a code-owned permission, not a database role in v1 (section 8, question O-1)                                                                          |

## 2. Entity list (v1)

| #   | Table (proposed)                         | Purpose                                                                                       | Mutable?                           |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | `business_public_profiles`               | One row per business that has ever started a profile: publication state, handle, live pointer | Yes (state machine only)           |
| 2   | `business_profile_revisions`             | One row per content version: status, review evidence, website                                 | Content frozen after submission    |
| 3   | `business_profile_revision_translations` | Per-locale display name, summary, description of a revision                                   | Only while the revision is a draft |
| 4   | `business_profile_revision_locations`    | Opt-in public places and service areas of a revision                                          | Only while the revision is a draft |
| 5   | `business_category_translations`         | Localized names for platform categories                                                       | Platform-managed                   |

**Not created in v1:** media, subcategories, view or impression records, an epoch counter, promotional or notification
tables, any B2B or Split 09 table, any consent table. **No existing table is altered.**

Conventions followed (verified on the baseline): `uuid` primary keys with `gen_random_uuid()`; `text` columns with named
`CHECK` constraints for enumerations; `timestamptz`; composite tenant foreign keys of the form
`(child_id, business_id) -> (parent.id, parent.business_id)` with `ON DELETE RESTRICT` and a `..._business_fk` name (as in
`benefit-application-saga.ts`); `createdBy`/`updatedBy` as plain uuids with no foreign key (as in `auditColumns`).

## 3. Column-level contract

### 3.1 `business_public_profiles`

| Column                   | Type        | Null | Default / rule                                                                  | Notes                                                                                                                                                                     |
| ------------------------ | ----------- | ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `business_id`            | uuid        | no   | PK; FK `businesses(id)` `RESTRICT`                                              | One publication record per business                                                                                                                                       |
| `profile_handle`         | text        | no   | UNIQUE; `CHECK ~ '^[A-Za-z0-9_-]{22}$'`                                         | 128-bit CSPRNG value, base64url, generated by the application; insert retries on a unique violation; **stable for the life of the record**; never derived from other data |
| `publication_state`      | text        | no   | `'unpublished'`; `CHECK IN ('unpublished','published','suspended','withdrawn')` |                                                                                                                                                                           |
| `published_revision_id`  | uuid        | yes  | composite FK, see below                                                         | The live revision. **Kept** while `withdrawn` or `suspended` so re-publish is possible (D-13)                                                                             |
| `published_at`           | timestamptz | yes  | set by the transition service                                                   | First or latest publication time; exposed to customers as `publishedAt`                                                                                                   |
| `withdrawn_at`           | timestamptz | yes  |                                                                                 |                                                                                                                                                                           |
| `suspended_at`           | timestamptz | yes  |                                                                                 |                                                                                                                                                                           |
| `suspended_by`           | uuid        | yes  |                                                                                 | Platform administrator; no FK (matches `auditColumns`)                                                                                                                    |
| `suspension_reason_code` | text        | yes  | `CHECK ~ '^[A-Z_]{3,40}$'`                                                      | Value list lives in code until the policy is approved (O-3)                                                                                                               |
| `version`                | integer     | no   | `1`; `CHECK >= 1`                                                               | Optimistic-lock counter, incremented on every transition                                                                                                                  |
| audit columns            |             |      | `created_at`, `created_by`, `updated_at`, `updated_by`                          | As `auditColumns`                                                                                                                                                         |

Constraints:

- `business_public_profiles_pointer_business_fk`: `(business_id, published_revision_id)` `->`
  `business_profile_revisions(business_id, id)` `RESTRICT`. The pointer can only reference a revision **of the same business**.
- `..._published_needs_pointer_check`: `publication_state <> 'published' OR published_revision_id IS NOT NULL`.
- `..._suspended_fields_check`: `publication_state <> 'suspended' OR (suspended_at IS NOT NULL AND suspension_reason_code IS NOT NULL)`.
- Row creation is **lazy**: no row exists until a business first saves a draft. A business with no row is treated as `unpublished`.
  Registration creates nothing (ruling R3).

### 3.2 `business_profile_revisions`

| Column                 | Type        | Null | Default / rule                                                                 | Notes                                                                                                                    |
| ---------------------- | ----------- | ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                   | uuid        | no   | PK, `gen_random_uuid()`                                                        |                                                                                                                          |
| `business_id`          | uuid        | no   | FK `businesses(id)` `RESTRICT`                                                 |                                                                                                                          |
| `revision_no`          | integer     | no   | `CHECK >= 1`                                                                   | Assigned by the service as max plus one inside the transaction                                                           |
| `status`               | text        | no   | `'draft'`; `CHECK IN ('draft','submitted','approved','rejected','superseded')` | **Five** revision statuses. `withdrawn` is a **publication** state only; a withdrawn profile's revision stays `approved` |
| `website_url`          | text        | yes  | `CHECK ~ '^https://[^\s]{1,2000}$'` and length                                 | https only; no credentials or fragments; query strings stripped on save (validation detail in BDPN-01B)                  |
| `content_digest`       | text        | yes  | `CHECK ~ '^[0-9a-f]{64}$'`                                                     | SHA-256 of the canonical content (section 4.3). Set at submission                                                        |
| `submitted_by`         | uuid        | yes  |                                                                                | Business user                                                                                                            |
| `submitted_at`         | timestamptz | yes  |                                                                                |                                                                                                                          |
| `reviewed_by`          | uuid        | yes  |                                                                                | Platform administrator                                                                                                   |
| `reviewed_at`          | timestamptz | yes  |                                                                                |                                                                                                                          |
| `review_reason_code`   | text        | yes  | `CHECK ~ '^[A-Z_]{3,40}$'`                                                     | Required when `rejected`; allowed codes live in code (O-3)                                                               |
| `review_note_internal` | text        | yes  | `CHECK length <= 500`                                                          | Never exposed to customers                                                                                               |
| audit columns          |             |      | as `auditColumns`                                                              |                                                                                                                          |

Constraints:

- `UNIQUE (business_id, revision_no)` and `UNIQUE (business_id, id)` (the target of the composite foreign keys).
- **At most one open draft per business:** partial unique index on `(business_id) WHERE status = 'draft'`.
- **At most one revision awaiting review per business:** partial unique index on `(business_id) WHERE status = 'submitted'`.
- `..._digest_required_check`: `status = 'draft' OR content_digest IS NOT NULL`.
- `..._review_fields_check`: `status IN ('approved','rejected','superseded') -> reviewed_by, reviewed_at NOT NULL`;
  `status = 'rejected' -> review_reason_code NOT NULL`; `status IN ('draft','submitted') -> reviewed_by, reviewed_at NULL`.
- **`..._separation_of_duties_check`:** `reviewed_by IS NULL OR submitted_by IS NULL OR reviewed_by <> submitted_by`.
  Self-approval is refused **by the database**, not only by application code.

### 3.3 `business_profile_revision_translations`

| Column         | Type | Null | Rule                                                                   |
| -------------- | ---- | ---- | ---------------------------------------------------------------------- |
| `revision_id`  | uuid | no   | PK part; composite FK to `business_profile_revisions(id, business_id)` |
| `business_id`  | uuid | no   | Carried for the composite tenant FK (`..._revision_business_fk`)       |
| `locale`       | text | no   | PK part; `CHECK IN ('en','es','fr','ar')` (the platform's closed set)  |
| `display_name` | text | no   | 2 to 80 characters after trim                                          |
| `summary`      | text | yes  | 1 to 160 characters when present                                       |
| `description`  | text | yes  | 1 to 1000 characters when present                                      |

Per-locale rules: only `display_name` is mandatory for a non-default locale. For the business's **default locale**,
submission additionally requires `summary` and `description` (D-04). All text is plain text; the content rules (no
markup, no URL, phone or email patterns, normalization) are specified in BDPN-01B and enforced in the application
validator. The database enforces length and locale only.

### 3.4 `business_profile_revision_locations`

| Column                       | Type    | Null | Rule                                                                               |
| ---------------------------- | ------- | ---- | ---------------------------------------------------------------------------------- |
| `id`                         | uuid    | no   | PK                                                                                 |
| `revision_id`, `business_id` | uuid    | no   | Composite tenant FK to the revision                                                |
| `position`                   | integer | no   | Display order, `>= 0`, unique per revision                                         |
| `kind`                       | text    | no   | `CHECK IN ('place','service_area')`                                                |
| `label`                      | text    | no   | 1 to 120 characters; the text customers see                                        |
| `country_code`               | text    | yes  | `CHECK ~ '^[A-Z]{2}$'`; required for `place`                                       |
| `city`                       | text    | yes  | 1 to 80 characters; required for `place`                                           |
| `region`                     | text    | yes  | 1 to 80 characters                                                                 |
| `street_address`             | text    | yes  | 1 to 160 characters; **only when the business opted in**; allowed only for `place` |

Constraints: `kind = 'place' -> city, country_code NOT NULL`; `kind = 'service_area' -> street_address IS NULL`.
**There is no latitude, longitude, branch reference or geometry column** (D-06 and the spec). Location text is stored as entered and
is **not translated** per locale in v1 (O-5).

### 3.5 `business_category_translations`

| Column        | Type | Null | Rule                                             |
| ------------- | ---- | ---- | ------------------------------------------------ |
| `category_id` | uuid | no   | PK part; FK `business_categories(id)` `RESTRICT` |
| `locale`      | text | no   | PK part; `CHECK IN ('en','es','fr','ar')`        |
| `name`        | text | no   | 1 to 80 characters                               |

The existing `business_categories.name` remains the English default and the fallback when a locale row is missing. Seeding the
names for `en, fr, es, ar` is a **content task that needs owner approval of the wording** (decision-record item N-4).

## 4. Rules that make the contract safe

### 4.1 State machine guard (database level)

A `BEFORE UPDATE` trigger on `business_public_profiles` (proposal) allows only these changes of `publication_state`, so
an illegal transition cannot be written even by a faulty service:

| From                                    | To            | Also required                                                                                 |
| --------------------------------------- | ------------- | --------------------------------------------------------------------------------------------- |
| (insert)                                | `unpublished` |                                                                                               |
| `unpublished`, `withdrawn`              | `published`   | `published_revision_id` references a revision with `status = 'approved'` of the same business |
| `published`                             | `published`   | The pointer moved to a newer `approved` revision (spec T7)                                    |
| `published`                             | `withdrawn`   | Pointer retained                                                                              |
| `unpublished`, `published`, `withdrawn` | `suspended`   | `suspended_*` fields set                                                                      |
| `suspended`                             | `unpublished` | `suspended_*` cleared; pointer retained                                                       |

Everything else raises an exception. The database cannot know the caller's role, so **who** may request a transition
stays an application authorization (BDPN-01B), while **which** transitions are legal is enforced in the database.

### 4.2 Immutability guard

- A `BEFORE UPDATE` trigger on `business_profile_revisions`: once `status <> 'draft'`, the columns `business_id`,
  `revision_no`, `website_url`, `content_digest`, `submitted_by` and `submitted_at` cannot change; `status` may change only
  along `draft -> submitted -> approved | rejected`, and `approved -> superseded`; `rejected` and `superseded` are terminal.
- `BEFORE INSERT/UPDATE/DELETE` triggers on the translation and location tables: allowed **only** when the parent
  revision is `draft`.
- A `draft -> submitted` change is refused unless the default-locale translation has a display name, summary and
  description, at least one location row exists, and `content_digest` is set (D-04).
- Precedent: the repository already uses triggers and `RAISE EXCEPTION` for immutability and append-only denial in the
  Gate 2 era migrations (for example `0061`, `0062`, `0064`, `0065` and `0066`).

### 4.3 Content digest

The approval is bound to **exactly what the moderator saw**. The digest is the SHA-256 (lowercase hex) of the canonical
serialization of: `website_url`; the translations sorted by `locale`; the locations sorted by `position`. Canonical form:
UTF-8, Unicode NFC, keys in a fixed order, no insignificant whitespace, absent fields as JSON `null`. The application computes
it at submission and recomputes it at approval; a mismatch aborts the approval (threat T-04). The exact canonicalization
function is a BDPN-01B deliverable and must be covered by test vectors.

### 4.4 Handle generation

`profile_handle` is 16 random bytes from a cryptographically secure source, base64url without padding (22 characters),
generated once when the publication record is created. It is never reused, never changes while the record exists, and is not
derived from `businesses.id`, the slug, a timestamp or a sequence. The internal business id never appears in discovery
responses (D-10).

### 4.5 Deletion and withdrawal of data

Businesses are soft-deleted; the foreign keys are `RESTRICT`, so profile history cannot be orphaned or cascaded away.
A soft-deleted or non-`active` business is excluded from discovery by the eligibility predicate and keeps its history as audit
evidence. No profile content is ever hard-deleted by the application in v1.

## 5. Indexes (proposed)

| Index                                                                                 | Purpose                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `business_public_profiles(profile_handle)` unique                                     | Handle lookup                                                                                                                                          |
| `business_public_profiles(business_id) WHERE publication_state = 'published'` partial | Fast list of published businesses                                                                                                                      |
| `business_profile_revisions(business_id, status)`                                     | Queue and state lookups                                                                                                                                |
| `business_profile_revisions(status) WHERE status = 'submitted'` partial               | Moderator queue                                                                                                                                        |
| `business_profile_revision_translations(locale, lower(display_name))`                 | Name search and ordering (search strategy, including any trigram extension, is decided in BDPN-01C, and extension availability must be verified first) |
| `business_profile_revision_locations(revision_id, position)` unique                   | Stable display order                                                                                                                                   |

## 6. Eligibility predicate (data-level definition)

The only definition of "discoverable". It is evaluated by the read query itself and **not** stored as a flag. Proposal as a view
or query (the choice is BDPN-01C):

```sql
-- illustrative, not executable migration code
SELECT p.profile_handle, t.display_name, t.summary, ...
FROM business_public_profiles p
JOIN business_profile_revisions r
  ON r.business_id = p.business_id AND r.id = p.published_revision_id AND r.status = 'approved'
JOIN businesses b ON b.id = p.business_id AND b.status = 'active' AND b.is_deleted = false
JOIN business_profile_revision_translations t
  ON t.revision_id = r.id AND t.locale = b.default_locale
WHERE p.publication_state = 'published'
  -- AND <plan entitlement term, reserved for D-24, read-only, added only once the owner decides>
```

Any inconsistency (pointer to a non-approved revision, missing default-locale translation) yields **no row**: the business is
omitted, never partially shown.

## 7. Migration plan (documentation only)

| Topic                      | Proposal                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Number of migrations       | **One**, named in the repository's style, for example `0068_business_public_profiles` (the next free number is 68 on this baseline, but the final number depends on what lands first). D-19: only after the existing backlog is applied                                                                                                                                                                                                          |
| Order inside the migration | 1. `business_category_translations`; 2. `business_public_profiles` without the pointer FK; 3. `business_profile_revisions` with its unique keys; 4. add the pointer composite FK; 5. translations; 6. locations; 7. check constraints; 8. partial and normal indexes; 9. guard functions and triggers                                                                                                                                            |
| Data backfill              | **None.** No row is created for any existing business. Category translation rows are seeded separately once the wording is approved (N-4)                                                                                                                                                                                                                                                                                                        |
| Permissions                | `profile:edit` and `profile:submit` are added to the permission catalog (`permissions.seed.ts`), to the default Owner and Admin role definitions (`role-provisioning.service.ts`), and applied to existing businesses' roles through a **backfill seed** in the established pattern (`role-permissions-backfill.seed.ts`). This is data work, separate from the schema migration. The moderation permission is code-owned and needs no migration |
| Rollback                   | Additive only. Stop reading, then drop in reverse order. No existing data changes                                                                                                                                                                                                                                                                                                                                                                |
| Existing-table impact      | **None.** No column is added to `businesses`, `branches`, `customers` or any other table                                                                                                                                                                                                                                                                                                                                                         |

## 8. Gate 2 impact (regenerated on the current baseline)

- **Pin sites.** A broad search of `.github`, `apps/api/scripts` and `apps/api/src` on `f098920` finds **22 files** that
  hard-code the migration count 68 or the last tag `0067_customer_preferred_locale`: 3 workflow files
  (`gate2-pg18-fixture-restore.yml`, `gate2-pg18-nonowner-rls.yml`, `gate2-pg18-synthetic-upgrade.yml`), 16 scripts under
  `apps/api/scripts/` (the `gate2-*` set, `verify-gate2-pg18-ephemeral.mjs`, `verify-gate2-pg18-nonowner-rls.mjs` and
  `gate2-staging-secret-readonly-preflight.mjs`) and 3 files under `apps/api/src/release/`
  (`gate2-postmigration-acceptance.ts` and its test, and `staging-migration-preflight.test.ts`).
  **Correction:** the earlier documents state 18; that count came from a narrower search pattern. Neither number is
  authoritative. The list must be **regenerated by search and checked by hand** when implementation starts.
- **Re-pin effect of one new migration:** journal length 68 to 69; last tag becomes the new tag; staging pending count 23 to 24
  (staging is at 45); the `staging-migration-preflight` expectations change accordingly. CI job `name:` values stay unchanged
  so required-check names do not move.
- **Scripts that enumerate all public tables** (`gate2-r9-runtime-role-contract`, `gate2-r10-disposable-tenant-rls`,
  `gate2-r11-disposable-principal-binding`, `gate2-b1-restricted-broker-denial`) compute their table inventory at run time.
  The five new tables enter that inventory automatically, so the runtime-role privilege and the tenant-isolation
  assertions must be **proven on disposable PostgreSQL 18** for them. A static review cannot prove this; it is a BDPN-01E
  verification item, not an assumption.
- **Row-level security.** On the baseline, forced row-level security plus dedicated `NOLOGIN` roles is used for the
  financial, evidence and custody tables (`0061` to `0066`); ordinary tenant tables rely on application-level tenant scoping
  plus composite foreign keys. This proposal follows the **ordinary tenant-table pattern plus database guards** (triggers,
  checks, composite keys). Whether moderation writes should instead be **privilege-separated at the database level** (a
  restricted role, as in Gate 2) is question O-1.

## 9. Open questions surfaced by this block (not decided)

| ID  | Question                                                                                                                     | Options                                                                                                                                              | Author's view                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O-1 | Enforce moderation privilege separation in the database (restricted role and forced RLS) or in the application plus triggers | (a) application authorization plus guards and the separation-of-duties check; (b) additionally a dedicated database role for approval and suspension | (a) for v1: it matches ordinary tenant tables and avoids new roles on a managed database. Choose (b) if the owner wants a database-enforced guarantee that no application bug can approve. This is a security-versus-complexity trade for the owner |
| O-2 | One open draft per business                                                                                                  | Allow one draft only (proposed) or several                                                                                                           | One keeps the review UI simple                                                                                                                                                                                                                      |
| O-3 | Where reason codes live                                                                                                      | In code until the content policy is approved (proposed), or a reference table                                                                        | Code first; promote to a table only if moderators need to edit them                                                                                                                                                                                 |
| O-4 | Digest scheme                                                                                                                | The canonical form in 4.3 is proposed; a different canonicalization changes every stored digest                                                      | Freeze it in BDPN-01B with test vectors before any data exists                                                                                                                                                                                      |
| O-5 | Translating location labels, city and region per locale                                                                      | Not translated in v1 (proposed) or add a per-locale location text table                                                                              | Not translated: place names are usually written locally; revisit if customers need it                                                                                                                                                               |
| O-6 | Revision retention                                                                                                           | Keep all history (proposed) or archive old rejected revisions after a period                                                                         | Keep for audit; no deletion in v1                                                                                                                                                                                                                   |

## 10. Test requirements for the eventual implementation (specified here, not written)

1. Constraint tests for every check, unique and partial-unique index above, each with a positive and a negative case.
2. Composite-key tests: a pointer or child row referencing another business's revision is rejected.
3. State-machine tests: every legal transition passes, every illegal one raises, in a disposable PostgreSQL 18.
4. Immutability tests: editing a submitted or approved revision, or its translations or locations, is rejected.
5. Separation-of-duties test: approving a revision with the submitting user is rejected by the database.
6. Handle tests: format, uniqueness, retry on collision, and that no handle equals or derives from a business id or slug.
7. Digest test vectors, including Unicode normalization and locale ordering.
8. Eligibility tests: unpublished, withdrawn, suspended, business suspended, business soft-deleted, missing default-locale
   translation: each yields no row.
9. Migration replay from the current head and from the 45-entry staging prefix, plus the Gate 2 re-pin check.
10. A check that **no existing table changed** and that no row is created at business registration.

## 11. Owner gate and acceptance

- **Owner gate:** approval of the entity list, the migration batching (already decided, D-19) and the open questions O-1 to O-6.
- **Acceptance criteria met by this document:**
  - every field of the spec's field contract is mapped to storage, deferred by an owner decision, or removed by one;
  - no existing table is altered and no synthetic field exists;
  - every decision it depends on (D-01, D-04, D-05, D-06, D-07, D-08, D-10, D-19) is recorded as decided;
  - the contract was reviewed against Splits 01, 02, 05, 07 and 08 and BDPN v1.0, and it introduces no consent, notification,
    promotional, loyalty, Community Points, Partner Credit or billing data.
- BDPN-01B, 01C, 01D and 01E are **not started** and still need their own explicit authorization.

> **Erratum (2026-11-12).** The statements in this document that staging is "at 45" or that "23 migrations are pending" are **superseded**. The repository record dated 2026-11-09 (commit 52b990c) reports both the production Neon project and the staging branch at 67 journal entries; only `0067` is beyond that record. The live state of each environment is **not verified**. See `BDPN_MIGRATION_PLAN_AND_STATE_CORRECTION.md`. The D-19 principle (backlog first, then one BDPN migration) stands; the backlog is `0067`.
