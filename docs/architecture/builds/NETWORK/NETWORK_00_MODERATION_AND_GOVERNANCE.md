# NETWORK-00 — Moderation and Governance

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY.** Baseline `origin/main` @ `7fd8bfe`. Parent: `decisions/ECHO_GRID_NETWORK_ARCHITECTURE_AMENDMENT_V1_PROPOSED.md`. Extends `builds/BDPN/BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md` and `BDPN_01_INTERIM_CONTENT_POLICY_DRAFT.md`.
Nothing here is legal advice. Jurisdiction-specific obligations need qualified counsel; this document names the questions, not the answers.

## 1. Principle

User-visible content creates continuing obligations (review, abuse handling, disputes). The Network opens **only as fast as moderation can be operated**. No content class is enabled until its policy, tooling, staffing and response process exist in writing and have run in practice on the smaller class before it.

## 2. Moderation model for v1 (proposed)

| Aspect                | Proposal                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timing (N-03)         | **Pre-moderation**: nothing business-authored or official is visible until approved                                                                                                             |
| Reviewers             | Platform admins with a code-owned moderation permission; never the author; never the submitter                                                                                                  |
| Official posts (N-09) | Authored by one platform admin, approved by a **different** platform admin                                                                                                                      |
| Edits                 | Every edit creates a new revision and is reviewed (D-14); the live approved revision stays visible until a new one is approved, unless suspended                                                |
| Machine checks        | Deterministic validation only (length, allowed characters, https link rules, rejected patterns); **no automated approval or rejection decisions**. Any future assistance is advisory and logged |
| Decisions             | Approve, reject with a code-owned reason, suspend, lift suspension, remove                                                                                                                      |
| Appeal                | Resubmission is the path (D-15); no promised timeframe to the public                                                                                                                            |

## 3. Policy requirements (must exist, in writing, before any business can publish)

1. A **content policy for posts** approved by the owner, extending the interim BDPN policy (what is allowed, prohibited, and how decisions are explained).
2. **Prohibited content classes** (illustrative; counsel to finalize): hate or harassment; threats; sexual content; illegal goods or services; fraud and scams; impersonation of another business or of Echo Grid; personal data of any person; misleading or unverifiable claims (price, health, results, awards); competitor disparagement; malicious or deceptive links; spam and repeated near-duplicates.
3. **Misleading promotions:** a post may not state an offer the business cannot or will not honour; offers need clear terms in the text (counsel to advise on disclosure).
4. **Reason-code list** (code-owned constant, extended from the interim policy) so rejections and removals are explainable and auditable.
5. **Transparency to the business:** every rejection shows a clear reason (D-15); removals show the policy reference.
6. **Record keeping:** every moderation action in `audit_log` with actor, action, entity, reason code.

## 4. Reporting

| Item               | Proposal                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Who can report     | Any signed-in customer; any business user (for posts by others)                                                                             |
| Reasons            | Code-owned list (spam, harassment, impersonation, misleading, illegal, personal data, other)                                                |
| Limits             | Per-user rate limit; duplicate reports collapse                                                                                             |
| Privacy            | The author never learns who reported                                                                                                        |
| Handling           | Reports queue for moderators; a post with repeated reports may be auto-**hidden pending review** only if the owner approves that rule (G-1) |
| Abuse of reporting | Repeated bad-faith reporting is itself reviewable                                                                                           |

## 5. Abuse cases and responses

| Abuse                                       | Preventive control                                                                                       | Detection                   | Response                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------- |
| Spam or flooding                            | Daily cap per business; pre-moderation                                                                   | Queue volume; duplicates    | Reject; suspend publishing for the business |
| Impersonation of a business or of Echo Grid | Posts only from a verified BDPN profile; official badge only for platform posts                          | Reports; moderator review   | Remove; suspend; verify identity again      |
| Fraudulent business account                 | Manual identity verification (D-21) before publication rights                                            | Reports; complaints         | Withdraw profile and posts                  |
| Fabricated reviews or testimonials          | Customer posts not in v1; business posts may not present customer quotes unless verifiable               | Reports                     | Reject; require evidence                    |
| Misleading promotions                       | Offer terms required in text; pre-moderation                                                             | Reports                     | Reject or remove                            |
| Harassment or doxxing of customers          | No customer content in v1; posts may not identify customers; pattern rejections                          | Reports                     | Remove; suspend                             |
| Malicious links                             | https only; one link; domain rule (C-3 in the content companion); render-time re-check                   | Reports; moderator check    | Remove; suspend                             |
| Moderator abuse or collusion                | Separation of duties; two-person rule for official posts; full audit; permission re-resolved per request | Audit review                | Revoke permission; investigate              |
| Post changed after approval                 | Immutable revisions plus digest; edits create new revisions                                              | Digest mismatch at approval | Block; alert                                |

## 6. Operations minimum before the first business can publish

| Requirement           | Detail                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------- |
| Named human reviewers | At least two platform admins able to moderate, so approval never depends on one person |
| Response expectation  | An **internal** target agreed by the owner; **no timeframe promised publicly** (D-15)  |
| Queue visibility      | A moderation queue with ages, with an alert when it exceeds an agreed size             |
| Escalation            | A written path for urgent or legal complaints (takedown requests)                      |
| Incident process      | Who can switch the Feed off (flag), and how quickly                                    |
| Training and guidance | The policy, reason codes and examples available to reviewers                           |

## 7. Customer-created content (not in v1): gate conditions

Customer posts, comments and shares open only when **all** are true:

- The business-publishing moderation process has run in practice and its volume and quality are known.
- N-15 (minimum age and eligibility) is decided.
- A report, block and removal path exists for customers.
- Counsel has reviewed review and testimonial rules and customer-content liability.
- Moderation capacity is sized for the expected volume.
- Customer deletion and edit controls exist, and retention is defined (N-11).

## 8. Sponsorship and advertising (not in scope; requirements recorded)

Before any paid or sponsored content exists: clear, persistent labelling of paid content; separation from organic content; rules on what may be advertised; consent for any outbound promotion (BDPN-02); billing authority (Splits 07 to 08 unchanged; no credits or discounts); and qualified legal review of advertising and consumer-protection rules in each market served. None of this is authorized here.

## 9. Legal and compliance questions for counsel (not answered here)

1. Platform liability and notice-and-takedown duties for user and business content in each target jurisdiction.
2. Rules for reviews, testimonials and endorsements, including fake-review prohibitions.
3. Advertising and promotion disclosure requirements.
4. Children and minimum age.
5. Data protection basis for follows and any future analytics; retention and deletion.
6. Intellectual-property complaints process.
7. Terms of service changes needed for business publishing and the content licence granted to the platform.

## 10. Open governance decisions

| ID  | Question                                                           | Author's view                                       |
| --- | ------------------------------------------------------------------ | --------------------------------------------------- |
| G-1 | Auto-hide a post pending review after N distinct reports           | Useful but can be abused; decide only after a pilot |
| G-2 | Who is accountable for the content policy and its changes          | Owner, with counsel's review                        |
| G-3 | Public "how moderation works" page                                 | Yes, before opening, without promising timeframes   |
| G-4 | Transparency report                                                | Later; after volume exists                          |
| G-5 | Whether business accounts can be suspended for repeated rejections | Yes, with a clear threshold and appeal path         |
