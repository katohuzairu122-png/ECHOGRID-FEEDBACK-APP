# NETWORK-15-T2-D1 — approved development contract

Date: 2026-11-23. Baseline: `aa7c016b7a3cd4aca4769414b4f18242ea2cc7fe`.

Authority: in this development conversation, the assistant presented the five
outcomes below and asked for development-only approval of NETWORK-15-T2-D1. The
Owner responded **“Proceed”**. This is the affirmative approval previously missing
from T1/#553. Earlier records marked PROPOSED describe the historical state; they
are superseded for this narrowly stated development contract.

Approved outcomes:

1. Restore activates membership only with valid current consent and verified eligibility.
2. Missing/stale consent leaves membership inactive until explicit acceptance after moderation clearance.
3. Restore cannot override voluntary Leave or existing bans.
4. Concurrent Restore/Leave cannot resurrect terminated membership.
5. Historical consent, balances and ledgers remain intact.

The approval authorizes implementation, disposable database/schema testing,
regressions, browser acceptance and a draft PR. It does **not** approve legal
wording/localizations, a terms version/effective date, publication, live enrollment,
deployment, shared migrations, production configuration, merging or T3.

## Minimal representation

The existing membership state machine gains `inactive`: moderation cleared,
existing membership retained, consent-dependent activation pending. Its Community
Points account is `closed`, with balance/history preserved. It is distinct from
voluntary `left`; `left_at` is not invented by Restore. `suspended` remains blocked
until authorized clearance. Existing platform permission `community:adjust` is
unchanged. No parallel membership store or new moderator permission is introduced.

Only fresh explicit Join/Rejoin can activate an inactive member. Legacy active
records are not rewritten or backfilled into consent; material-change enforcement
for already-active members is not silently introduced. If a legacy active member
wants to accept through self-service, the existing Leave followed by explicit
Rejoin establishes a real new acceptance rather than fabricating historical proof.

No approved effective terms are shipped. Candidate `community-membership-v1.0`
remains unapproved and unavailable for customer acceptance.
