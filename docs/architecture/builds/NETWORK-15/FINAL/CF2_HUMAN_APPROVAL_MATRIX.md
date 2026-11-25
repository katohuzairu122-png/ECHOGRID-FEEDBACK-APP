# Consolidated human-review approval matrix (CF-READINESS-2)

**Every row is UNAPPROVED.** The Owner's policy rulings L1–L7 are applied as **product-design directives**, not as legal approval. No reviewer, reference or date is filled in. AI-assisted translations are drafts, not certified legal translations; no jurisdictional compliance is claimed.

## 1. Draft artifacts now in the repository (docs/legal/community/drafts/)
All four files carry the banner "DRAFT — NOT LEGALLY APPROVED" (in their own language), share 25 clause identifiers (A1–G4), identical `{version}`/`{effectiveDate}` placeholders, and five identical `[[LEGAL-DECISION Dn]]` markers. English is the proposed canonical source. A guard test (`community-legal-drafts.test.ts`) fails if any language loses a clause, a placeholder or a marker, or if the committed hash manifest drifts.
| Locale | File | Bytes | SHA-256 of content (draft manifest, `sha256-utf8`, same function the terms authority uses) |
|---|---|---|---|
| en | `community-terms.en.md` | 4263 | `0a515a14fb42a774c1b62a5cd682459a180bfb9bad405c6ae547df39373423dc` |
| fr | `community-terms.fr.md` | 5465 | `344224ad14b431cf7ac8290c750fa581085191b50160cae36a34e53315980d35` |
| es | `community-terms.es.md` | 5101 | `75209e325385a65d4bf23134fc6445d24db2040af521c97eca7cc0def21492ae` |
| ar | `community-terms.ar.md` | 6440 | `3b422476262ab7850639b702f77f84c10f949874a4000cce1b79e58132abdc90` |
Manifest: `BUNDLE.draft.json` — status "DRAFT — NOT LEGALLY APPROVED"; publication id, version, dates, approval and manifest hash are all **null** (a manifest hash needs a real publication id and dates). **Nothing is seeded or published; `community_terms_current` stays empty.** Regenerate with `node apps/api/scripts/community-legal-bundle.mjs`; `--check` detects drift.

## 2. How each Owner ruling is reflected
| Ruling | Product behavior (already enforced) | Draft text | Status |
|---|---|---|---|
| L1 membership terms | voluntary, explicit Join; states; suspension | sections A–C | UNAPPROVED |
| L2 consent: explicit for Join, Rejoin and **every** Restore; unchecked; no inherited consent | enforced by the consent runtime; UI unchecked (verified in browser) | A2, G1–G4 | UNAPPROVED |
| L3 points: no monetary value, no cash, no transfers, separate from business loyalty, auditable | ledger separate; no transfer or redemption capability exists | D1–D4 | UNAPPROVED (D4 balance-after-leaving = decision D2) |
| L4 privacy/deletion reconciliation | pending deletion blocks Join/Rejoin/Restore; Leave allowed; cancel re-allows (tested) | E1–E4 | UNAPPROVED (retention durations = decisions D3, D4) |
| L5 versioning: immutable, unique ids, effective dates, per-language hashes | terms registry is immutable with guards; per-language hashes in the manifest | F1 | UNAPPROVED |
| L6 material changes → fresh consent; zero-member baseline | stale-publication denial; 0 memberships on staging and production (read-only, 2026-11-25) | F2, F3 | UNAPPROVED (existing members = decision D5) |
| L7 publication bundle | prepared as draft manifest; not published | — | NOT PUBLISHED |

## 3. Reviewer and owner decision register
| # | Decision / review | Who | State |
|---|---|---|---|
| H-1 | Legal approval of L1–L6 English canonical text | qualified legal reviewer | PENDING |
| H-2 | French equivalence | qualified French reviewer + legal owner | PENDING |
| H-3 | Spanish equivalence | qualified Spanish reviewer + legal owner | PENDING |
| H-4 | Arabic equivalence, reading order, numbers and dates | qualified Arabic reviewer + legal owner | PENDING |
| D1 | Dispute procedure, timelines, escalation (clause C3) | Owner + legal | PENDING |
| D2 | Points balance after leaving; restored on rejoin? (D4) | Owner + legal | PENDING |
| D3 | Retention period for consent evidence (E1) | legal | PENDING |
| D4 | Retained categories, durations, legal-hold procedure (E4) | legal | PENDING |
| D5 | Existing members when terms change (F3) | Owner + legal | PENDING |
| O-1…O-7 | Operators, support, thresholds, retention, RPO/RTO, pilot (see `CF2_OPERATIONS_RUNBOOK.md`) | Owner | PENDING |
| P-1 | Authorize staging migration 0088–0090 (`G2` record) | Owner | PENDING |
| P-2 | Production migration, deployment, publication, flags, activation | Owner (separate records) | NOT AUTHORIZED |
