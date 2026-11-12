# NETWORK-00 — Phasing, Threat Matrix, Tests and Release

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY.** Baseline `origin/main` @ `7fd8bfe`. Parent: `decisions/ECHO_GRID_NETWORK_ARCHITECTURE_AMENDMENT_V1_PROPOSED.md`. Companions: content model and moderation documents in this folder; BDPN-01E for the shared migration and release method.
Nothing here authorizes a block, a migration, a release or any public claim.

## 1. Sequencing (each block is separately authorized; none auto-advances)

| Order       | Block                                           | Depends on                                                                      | Content                                                                                                            |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 0           | Phase 1 public copy                             | Done (merged)                                                                   | Positioning only; no network claim                                                                                 |
| 1           | BDPN-01 (A to E, designs done)                  | Owner answers, D-16, D-24                                                       | Published business profiles and discovery. **Prerequisite for every NETWORK block**                                |
| 2           | **NETWORK-01** Official and business publishing | BDPN-01 live in at least staging, content policy for posts, two reviewers named | Posts, revisions, moderation, reports, audit. No customer-facing feed beyond what is needed to prove it internally |
| 3           | **NETWORK-02** Feed read model and Follow       | NETWORK-01                                                                      | Signed-in feed (deterministic, no-store), follows (count at most), "Following" filter                              |
| 4           | **NETWORK-03** Customer engagement              | Conditions in the moderation companion, section 7                               | Customer posts and reactions, only if gated conditions are met                                                     |
| 5           | **NETWORK-04** Business Network (B2B)           | A Split 09 specification (not yet written)                                      | Separate tables, separate permissions, no feed exposure                                                            |
| 6           | **NETWORK-05** Commercial                       | D-24, billing authority, legal review                                           | Subscription gates, sponsored placement, analytics: separate approvals                                             |
| 7           | **NETWORK-06** Consent-based promotion          | BDPN-02 to 04                                                                   | Email, SMS or push, only with per-channel customer consent                                                         |
| Every block | **Certification**                               | The block itself                                                                | Each block carries its own tests, CI, browser and API-denial verification (not deferred to a final block)          |

Differences from the earlier proposals: certification is per block, not one final block; discovery precedes any publishing; customer posts are gated by capacity, not scheduled by phase; B2B waits for its own specification.

## 2. Per-block acceptance (every NETWORK block)

1. Reconcile with the latest `main`, BDPN and prior decisions; list conflicts as a stop.
2. A threat and consent review for the block.
3. Tests at every layer (section 4), including real-router permission tests and a mutation check proving each gate fails when removed.
4. Verification on a disposable database and a production build with synthetic fixtures; no production data.
5. Hosted exact-head CI green.
6. Owner completion report listing executed versus unverified items.
7. Flag default off; deployed dark; activation is a separate owner decision per environment.

## 3. Threat matrix (design level)

| ID    | Threat                                             | Control                                                                                                       | Layer              |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------ |
| NT-01 | Unapproved or changed content shown                | Pre-moderation; immutable revisions; digest recomputed at approval                                            | DB and service     |
| NT-02 | Post from an ineligible business visible           | Visibility predicate joins BDPN eligibility in the query; never cached                                        | API and DB         |
| NT-03 | Existence leak (unpublished, suspended, withdrawn) | One uniform not-found for every cause                                                                         | API                |
| NT-04 | Cross-tenant authoring or reading                  | Composite tenant foreign keys; business-wide permission; tenant context on each route                         | API and DB         |
| NT-05 | Self-approval; collusion                           | Reviewer differs from submitter (CHECK and service); two-person rule for official posts; audit                | DB and service     |
| NT-06 | Impersonated session authors or moderates          | Impersonation denied on write and moderation routes                                                           | API                |
| NT-07 | Script or markup injection                         | Plain text only; character-class rejection; output escaping                                                   | API and UI         |
| NT-08 | Phishing or malicious link                         | https only, one link, domain rule, render-time re-check, `nofollow noopener noreferrer`                       | API and UI         |
| NT-09 | Scraping or enumeration                            | Signed-in only; customer-keyed rate limit; page cap; no totals; opaque handles                                | API                |
| NT-10 | Follower identity leak                             | Count at most; no identities to businesses; deletion with the account                                         | API and DB         |
| NT-11 | Hidden tracking of reading                         | No view counters or history (D-17); network capture test                                                      | API and web        |
| NT-12 | Follow treated as consent or membership            | Follow writes only the follow row; non-effect tests on memberships, accounts, grants, notifications, messages | Service and tests  |
| NT-13 | Social action awards points or credits             | No path to Community Points or Partner Credits; non-effect tests on ledgers                                   | Service and tests  |
| NT-14 | B2B content reaching the feed                      | Separate tables; feed code cannot reference them; schema review                                               | DB and code review |
| NT-15 | Moderator over-reach                               | Code-owned permission; minimum data; every access audited                                                     | API                |
| NT-16 | Duplicate or lost update on retry or concurrency   | Idempotency keys; expected-version locking                                                                    | API and DB         |
| NT-17 | Feed switched on prematurely                       | Flag default off per environment; every route answers "not enabled" when off                                  | Config             |
| NT-18 | Caching of private or withdrawn content            | `private, no-store`; service-worker bypass; browser check that a removed post disappears on the next request  | API and web        |
| NT-19 | Moderation queue overwhelmed                       | Daily publish caps; named reviewers; queue alert; flag-off incident path                                      | Operations         |
| NT-20 | Misleading public claims about the network         | Claims guard test (as for the landing page); claims only for released features                                | Process and tests  |

## 4. Test requirements (specified, not written)

| Layer                      | Required tests                                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                       | Validation (lengths, characters, links), digest vector, state machine, reason codes                                                                                                                                                             |
| Service                    | Every legal and illegal transition; idempotency; version conflict; separation of duties                                                                                                                                                         |
| API (real routers)         | Permission matrix for each actor (business owner, business staff, branch-scoped, moderator, impersonator, customer, suspended customer, anonymous); uniform not-found; no-store headers; rate limits per customer                               |
| DB (disposable PostgreSQL) | Triggers and constraints fire for a direct SQL session; composite foreign keys; reviewer differs from submitter; immutability; cascade on customer deletion for follows                                                                         |
| Browser                    | Feed states (list, empty, no match, unavailable, not enabled); report flow; follow and unfollow; Arabic layout at 390 and 1280 px; keyboard path; contrast                                                                                      |
| Non-effects                | Row counts of memberships, loyalty accounts and transactions, Community Points tables, consent grants, notifications and messages **identical** before and after a feed session; only the expected `GET` calls and follow writes on the network |
| Disabled mode              | Flag off: routes answer not enabled; entry points hidden                                                                                                                                                                                        |
| Existing behaviour         | Community hub, Surveys, loyalty, cashier workspace unchanged                                                                                                                                                                                    |
| Claims                     | A guard test that public copy contains no network claim before release                                                                                                                                                                          |

## 5. Privacy and data-protection checklist (before NETWORK-02)

- Data inventory for follows and reports; purpose; retention; deletion on account closure.
- Confirm no profiling or inference from follows.
- Confirm business-side visibility is count-only.
- Confirm the lawful basis and notice text with counsel.
- Confirm that no analytics or tracking tables exist.

## 6. Release, activation and rollback (aligned with BDPN-01E)

1. Migration backlog reconciled first (D-19); then BDPN-01; then the Network migration for NETWORK-01 (additive, empty).
2. Gate 2 journal and last-tag re-pin updated in the same change; job `name:` lines unchanged.
3. Deploy dark. Activate per environment with a flag: staging first, internal accounts only; production only by a separate owner decision.
4. **Rollback:** flag off (immediate, no data change); redeploy the previous release; drop tables only while empty or after export, as a separate authorized operation.
5. Public claims are written after release verification against the deployed behaviour.

## 7. Risks

| Risk                                               | Mitigation                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Empty feed at launch (cold start)                  | Official posts first; feed opens only when enough approved content exists; launch with clusters |
| Moderation cost                                    | Pre-moderation caps; named reviewers; queue alerts; customer posts last                         |
| Scope creep into a social product                  | v1 is text-first, no media, no comments; each addition is its own gated block                   |
| Privacy pressure from business growth incentives   | Count-only follows; no audiences; no exports; consent contract separate                         |
| Commercial uncertainty                             | Validate merchant demand before any advertising product; D-24 first                             |
| Name and concept confusion (Community versus Feed) | Reserve namespaces; consistent copy                                                             |

## 8. Success measures (targets set after a pilot)

Active customers (not registered); average businesses followed per active customer; share of eligible businesses that publish; approval and rejection rates; moderation response time; report rate per thousand posts; return rate; no measure uses reading history (D-17).

## 9. Decisions needed to start NETWORK-01 (summary)

1. N-01 to N-17 (parent record), especially N-03 (pre-moderation), N-06 (live profile required), N-07 (text only), N-09 (two-person official posts).
2. BDPN-01 answers (01A O-1 to O-6 and A-1; 01B O-B1 to O-B5; 01C O-C1 to O-C7; 01D O-D1 to O-D5; 01E O-E1 to O-E5), D-16 and D-24.
3. Content policy for posts and two named reviewers.
4. Authorization of NETWORK-01 as its own implementation block.
