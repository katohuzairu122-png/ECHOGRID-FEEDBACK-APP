# G3 / G4 — legal documents and localization: approval-ready matrix

**NONE OF THESE IS APPROVED. NO LEGAL TEXT IS PUBLISHED. This is not legal advice or certification.** Prepared 2026-11-25.
The English drafts below already exist; this matrix is the single list the Owner and reviewers sign against. No reviewer is named or assumed.

## G3 — documents requiring approval before any publication
| # | Artifact | Draft location | Technical status | Approval status |
|---|---|---|---|---|
| L1 | Community membership terms (eligibility, membership, conduct, enforcement, disputes) | `NETWORK/NETWORK-15-T1/COMMUNITY_MEMBERSHIP_TERMS_DRAFT.md` (sections A–I) | Matches implemented states (join/left/inactive/suspended) | UNAPPROVED |
| L2 | Join / Rejoin / fresh-Restore consent text (unchecked, explicit, separate) | `COMMUNITY_CONSENT_CONTRACT.md`, `AR02/LEGAL_REVIEW_DRAFT.md` "consent presentations" | Server enforces explicit acceptance, publication id/version/hash, locale and idempotency | UNAPPROVED |
| L3 | Community Points rules (earning, reversal, no cash value, adjustments) | Terms draft section D | Ledger integrity tested; no issuance authorized | UNAPPROVED |
| L4 | Privacy, withdrawal and retention provisions (consent evidence retained; effect of leaving; relation to the deletion request) | Terms draft section E/F, `LEGAL_REVIEW_DRAFT.md` data-governance record | Evidence rows are immutable by design; wording must align with the 30-day deletion-request wording (R7) | UNAPPROVED |
| L5 | Policy versioning and effective-publication process | `AR02/OPERATING_RECOVERY_MODEL.md` D04 section | Publication pointer/guards exist in 0088; **no application publisher endpoint exists** | UNAPPROVED |
| L6 | Existing-member treatment and material-change notices | Terms draft section H, AR01 O4 | There are **0** Community members at both targets, so no legacy members exist today | DECISION NEEDED (O4) |
| L7 | Immutable publication bundle (id, version, effective date, locale hashes) for staging then production | none (must be produced after L1–L5 and G4) | Nothing is seeded; `community_terms_current` stays empty | NOT PRODUCED |

Open legal decisions recorded for the Owner: jurisdictions and notice requirements; retention periods; whether Community Points may have any monetary meaning (current design: none); how leaving interacts with a pending account-deletion request.

## G4 — localization
### Technical certification (independent of legal equivalence) — VERIFIED on `main` 1ef2145
- 116 Community message keys in `loyalty.json`: en, es, fr, ar all have the same 116 keys (0 missing, 0 extra).
- `html` carries `dir="rtl"` for Arabic (`apps/web/src/app/layout.tsx`), `ltr` otherwise.
- Real Chromium journeys in `network-draft-publication.integration.test.ts` exercise Join, Rejoin and Restore containment in en, fr, es and ar at 375px and 1280px, asserting `dir` and the localized copy (results in the certificate).
- Web i18n unit suites pass (6 files, 99 tests); web Community unit suites pass (4 files, 41 tests).

### Legal-translation review matrix (reviewers UNASSIGNED)
| Artifact | en | fr | es | ar |
|---|---|---|---|---|
| L1 terms | draft; approval pending | no artifact | no artifact | no artifact |
| L2 consent texts | draft; approval pending | UI strings only | UI strings only | UI strings only |
| L3 points rules | draft | no artifact | no artifact | no artifact |
| L4 privacy/withdrawal | draft | no artifact | no artifact | no artifact |
UI strings are not legal artifacts and must not be promoted into a publication. Each locale needs a qualified native reviewer working with the legal owner; Arabic also needs reading-order and number/date review of the final artifact (not only the UI).

## Sign-off block (blank by design)
Legal approver ______ ref ______ date ______ · Reviewers en ______ fr ______ es ______ ar ______
