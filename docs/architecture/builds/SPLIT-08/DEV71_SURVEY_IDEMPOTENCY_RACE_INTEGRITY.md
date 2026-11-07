# DEV-71 — Survey Participation Idempotency Race Integrity

**Authorization:** Development only. No migration, settlement, reward/point creation, provider access, merge or deployment.

## Verified gap
Survey participation start checked ownership and `invalidated` state when an idempotency key was found on the first read. The same key could also appear after the repeat-policy lock or be returned by a concurrent insert-conflict path; those paths checked ownership but not invalidation. As a result, an invalidated row could be treated as a valid replay.

## Change
- Introduce a common fail-closed `assertReusableSurveyParticipation` gate.
- Invoke it on first lookup, post-lock lookup and final insert conflict result.
- Preserve existing HTTP 409 `IDEMPOTENCY_CONFLICT` for foreign identities and 409 `SURVEY_PARTICIPATION_INVALIDATED` for revoked participation.
- Regress the distinct race paths using transaction and repository fakes, verifying no consent renewal or record mutation occurs after denial.
- Valid same-customer, non-invalidated replay retains existing behavior.

This does not change transaction isolation, replay policy, external event publishing, or economic authority. Full exact-head CI required.
