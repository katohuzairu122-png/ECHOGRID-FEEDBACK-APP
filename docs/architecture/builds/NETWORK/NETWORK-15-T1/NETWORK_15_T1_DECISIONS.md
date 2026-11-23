# NETWORK-15-T1 — decision register, reconciliation and release gates

**Status: OWNER/LEGAL REVIEW REQUIRED — NO ACTIVATION.**
Date: 2026-11-21. Repository baseline:
`f2f9212d502607ee24af203dcb2fcf865a55b8ad`.

## Reconciliation

NETWORK-15 #549 is merged (`303b17525ff9102d98c01eab01535ed6cab558d6`), including
safe state/verification/Leave controls and the account-lock award correction.
N14-READ-01 is REJECTED and documented by merged #548. Verified-phone Feed access
and existing join assurance remain in force. Customer-auth #550 is merged; open
#551 is a separate authentication follow-up and is not imported or modified.
No equivalent approved Community terms/publication/consent contract was found.

Documents live under the established `docs/architecture/builds/NETWORK/` convention,
in this scoped `NETWORK-15-T1/` folder rather than a competing root directory.

## Subsequent T2 development ruling — 2026-11-23

The final NETWORK-15-T2 Owner dispatch approves fresh explicit versioned consent
for Join, terminated-membership Rejoin and **every Restore**. A prior consent may
not be reused for Restore. Atomic grant/audit/activation, current lifecycle binding,
retry/concurrency protection and unchanged tenant/phone rules are required.
The canonical runtime decision is
[NETWORK_15_T2_D1_APPROVED.md](../../NETWORK-15/NETWORK_15_T2_D1_APPROVED.md).
It supersedes conflicting technical proposal/unimplemented statements below for
T2 development (explicit acceptance, Community registry/purpose, immutable evidence,
Rejoin and Restore integration). The table below preserves the historical T1
reconciliation; legal wording, effective publication, material-change/retention
policies and shared-environment activation remain separate approval gates.

## D1–D10

| ID | Recommendation | Existing authority / decision still required |
| --- | --- | --- |
| D1 Free, voluntary membership | Approve free voluntary Community membership, one per global customer; no auto-enrollment | Voluntary explicit opt-in/one account are in frozen Split 05; the free-membership wording is PROPOSED, not newly approved here |
| D2 Verified-phone eligibility | Retain authoritative phone assurance for Join/Rejoin and Feed; never treat it as a platform permission | Existing `customer-verification.ts`, Community service and N14 rejection govern; draft legal wording still needs review, no relaxation proposed |
| D3 Version/effective date | Candidate `community-membership-v1.0`; approved version NONE; effective date NONE | Owner/legal approval plus immutable publication needed; no reuse of global LegalPage date |
| D4 Explicit checkbox | Independent unchecked checkbox plus deliberate Join/Rejoin, strict server boolean | Business loyalty has a precedent; Community acceptance contract is PROPOSED and not inferred from business consent |
| D5 Immutable evidence | Reuse consent-grant projection plus mandatory append-only audit event and exact publication hash | Audit immutability exists; new purpose, publication registry, payload/idempotency and atomic integration need architecture approval |
| D6 Material changes | New immutable publication; renewed explicit acceptance only under an approved change policy | Materiality, notice, timing, allowed fallback and nonacceptance effects UNRESOLVED; no new Feed gate, forfeiture or suspension |
| D7 Rejoin | Fresh explicit current-version acceptance with a current lifecycle basis; retain identity/history | Existing left->active transition is not fresh consent proof; approve required new evidence and legacy handling |
| D8 Retention | Minimize new evidence, retain immutable pseudonymous history according to separately approved policy and holds | Exact period/legal basis, projection lifecycle/cascade and privacy compatibility require legal/privacy review; no new retention schedule |
| D9 Jurisdiction/legal review | Owner appoints legal/native-language review and resolves jurisdiction, notices, disputes and applicable Privacy Policy | UNRESOLVED; no arbitration, liability, refund or statutory obligation invented |
| D10 Activation authority | Explicit Owner approval after legal, architecture, migrations, security/browser and separate release authorization | T1 draft/merge/green CI does not grant activation or deployment; Join/Rejoin stays disabled |

No decision becomes approved merely by appearing in the assignment, draft, test
fixture or this table. Existing authorities are preserved only for their actual
scope; they are not signatures approving these terms or a new consent purpose.

## Technical dependencies and exact boundaries

- `consent_grants` CHECK/types lack a Community purpose; the existing projection is
  mutable. A purpose/type extension is a prospective schema change requiring
  separate approval. Do not borrow another purpose or create parallel consent storage.
- No authoritative Community publication registry/current pointer exists. Registry
  source, immutable artifacts/locale manifest, global-currentness/locking and
  runtime read rights require review. No registry or legal route is created here.
- `audit_log` is append-only under 0085. Its actor FK is staff-only. A future customer
  evidence event uses null staff actor and minimal authenticated customer context;
  write it inside the domain transaction and propagate failure. Existing best-effort
  middleware is not acceptance authority.
- 0086 retains customer identity-free shells and immutable histories. Review new
  reference payloads/retention compatibility with the privacy owner; no D2 code,
  erasure exception, historical rewrite or privacy operation is authorized.
- Legacy Community `/join` currently accepts nonempty `policyVersion` without an
  approved-version/acceptance authority. UI remains disabled. A future approved
  integration must close every API gateway bypass before customer activation.
- Leave/Join lifecycle basis, publication currentness, replay equivalence and
  evidence ordering need mandatory transactional integration. Existing row locks
  and uniqueness are reused, not replaced by client claims or UI hiding.
- Existing post-commit pending-award reevaluation and exactly-once ledger rules
  remain unchanged; do not create new point rules, amounts, financial activation
  or business loyalty consent by accepting Community terms.

Migration journal at inspection ends at `0087_customer_pending_registration`
(index 87, following the existing 0080–0086 security/privacy chain), already in
merged authentication #550 on this baseline. No number is reserved, no migration
is generated or executed on a shared database. A later authorized schema block
must re-fetch the journal and competing PRs, review D2/runtime compatibility and
apply only to disposable environments until separate release permission exists.

## Activation checklist — all remain future gates

1. Explicit D1–D10 resolutions with authoritative references and legal review.
2. Approved accessible terms, reviewed en/fr/es/ar artifacts and immutable hashes.
3. Approved current-publication registry and consent-purpose/schema contract.
4. Separate migration allocation/approval, runtime privileges and privacy review.
5. Server-resolved terms, strict explicit request, mandatory atomic evidence and
   lifecycle/idempotency protection on ALL enrollment gateways.
6. Approved isolated implementation tests including database/Worker concurrency,
   safe DTOs, Leave, stale replay, history and award non-effects.
7. Real customer Join/Rejoin browser acceptance with reviewed terms; current T1
   model/disabled-UI tests are insufficient.
8. Exact-head green CI, Owner review and separate activation/deployment approval.

## Evidence / testing language

`community-membership-consent.design.test.ts` is a Vitest **reference model** using
synthetic approvals only. It is never imported by production and does not approve
the candidate terms. `community-consent-storage-design.integration.test.ts` probes
current constraints on disposable PostgreSQL. Existing Network HTTP/Chromium
suites verify retained disabled Join/Rejoin and existing permitted capabilities.
The completion report must separate these categories and mark future approved
Join/Rejoin acceptance NOT RUN. No test/CI change may hide a missing policy guard.

## Informational review references, not jurisdiction selection

Repository sources: frozen Split 05; NETWORK-14/15 records; Community membership,
award and customer route services; shared business join-consent schemas;
`consent-grants.ts`, `consent-grant.repository.ts`, `consent-dto.ts`;
`audit-log.ts`, `audit-log.repository.ts`, `middleware/audit.ts`; migrations
0085/0086; `/terms`, `/privacy` and the existing `LegalPage` component.

The [FTC's 2022 staff-report announcement](https://www.ftc.gov/news-events/news/press-releases/2022/09/ftc-report-shows-rise-sophisticated-dark-patterns-designed-trick-trap-consumers)
illustrates risks from preselected choices and obscured disclosures. It is an
informational design reference, not a conclusion that US law applies, a legal
opinion, or approval of this draft. Reviewers must decide the applicable law.
