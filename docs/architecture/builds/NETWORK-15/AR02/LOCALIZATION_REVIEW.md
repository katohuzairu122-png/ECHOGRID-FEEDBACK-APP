# Community legal localization acceptance

**DRAFT — LEGAL REVIEW REQUIRED — NOT APPROVED.** No translation is published,
certified or inserted into a registry by this matrix. References:
[decisions D02/O2](READINESS_AND_OWNER_DECISIONS.md),
[English review draft](LEGAL_REVIEW_DRAFT.md), existing `loyalty.json` files and
`CommunityEnrollmentControls`/layout at the recorded main baseline.

## Four-language review matrix

| Locale | Existing UI assessment                                                                                                                           | Legal content readiness                                | Required reviewers/evidence                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| en     | Explicit acceptance, separate Restore label and inactive explanation present; version/date/count bindings present                                | T1/AR02 English drafts only; not approved or effective | Named legal/policy reviewer; resolved redline; exact final text/version/hash and approval reference.         |
| fr     | `j’accepte expressément` expresses explicit acceptance; `Rétablir` and inactive wording require acceptance; technically consistent on inspection | No approved French legal artifact established          | Named native French + legal reviewers; canonical comparison, glossary, exact bytes and approval.             |
| es     | `acepto expresamente` and `Restaurar` retain affirmative acceptance and inactive state; required bindings present                                | No approved Spanish legal artifact established         | Named native Spanish + legal reviewers; same evidence, including termination/withdrawal meaning.             |
| ar     | Explicit affirmative wording, Restore and inactive explanation present; layout sets dir=rtl and server records locale                            | No approved Arabic legal artifact established          | Named native Arabic + legal reviewers; RTL/bidirectional terminology/number/link assessment and exact bytes. |

These are **PARTIALLY VERIFIED semantic observations**, not professional legal
translation approval. Technical presence/behavior is VERIFIED. Do not promote UI
strings, machine translations or synthetic fixtures into a legal publication.
Required reviewer names and approval references: **UNASSIGNED / NONE RECORDED**.

## Required acceptance checklist for each legal artifact

- [ ] Resolve the canonical English legal draft and all placeholders before
      translating; record the actual policy version/effective metadata, not the
      general legal-page display date or AR02 document revision.
- [ ] A native-language reviewer and legal/policy reviewer compare every clause,
      recording revision, issues, disposition, names and approval reference/date.
- [ ] Preserve separate meanings for account sign-in, verified phone, Community
      membership, business loyalty and Community Points. Phone is not consent or a
      permission grant; Community membership is not a new Feed gate.
- [ ] Join, terminated-membership Rejoin and fresh Restore each retain deliberate
      acceptance. Platform clearance remains inactive, not customer consent; a
      suspended user is not promised self-reactivation.
- [ ] Withdrawal/termination, accounting preservation, legal requests, privacy,
      contact/jurisdiction and material-change wording match approved policy. Do not
      silently add cash value, guarantees, forfeiture, arbitrary deadlines or rights.
- [ ] Freeze UTF-8 bytes, punctuation, line endings and Unicode form after approval.
      Existing hashing does not normalize them. Each locale has its own content hash;
      the canonical manifest binds all locales plus common publication/version/dates.
      A translation edit requires newly reviewed immutable content/version handling.
- [ ] Verify the approved common publication/version and requested locale resolve
      through `CommunityTermsAuthority`; no missing/unreviewed-language fallback.
      Before effectivity, keep it non-current; missing/invalid authority fails closed.
- [ ] Review 375px/1280px, keyboard and screen-reader affordances, text-region
      scrolling, contrast, wrapping, version/date/count and Arabic bidirectional UUID/
      version/URL presentation. Automated checks are not a full accessibility audit.
- [ ] Confirm unchecked consent, disabled submission until acceptance/eligibility,
      stale-state refresh/reacceptance, safe retry, no SMS on view and no automatic
      membership mutation. Error text must not claim consent/activation succeeded.
- [ ] Confirm immutable evidence stores the locale actually displayed plus its
      artifact hash/version, not a browser-controlled claim of verification.
- [ ] Approve release artifact IDs and hashes; archive reviewed text and reviewer
      references under approved evidence access/retention. No real consent is collected
      during review. Obtain separate publication and activation authorization.

## Technical evidence and remaining gaps

Fresh AR02 inspection checks 12 required consent/Restore UI keys and `{version}`,
`{date}`, `{count}` in each locale. Existing exact-implementation Chromium evidence
covers four locales at 375px/1280px with synthetic terms. Arabic root layout sets
`dir="rtl"`; missing legal locale is rejected by the actual terms authority.
Acceptance evidence includes version, displayed locale, artifact and manifest.
No legal artifact, professionally reviewed glossary, accessibility reviewer or
approval reference is manufactured by AR02. If approved text requires unsupported
presentation, record a separate bounded implementation request; do not alter legal
or authentication UI during this documentation block.
