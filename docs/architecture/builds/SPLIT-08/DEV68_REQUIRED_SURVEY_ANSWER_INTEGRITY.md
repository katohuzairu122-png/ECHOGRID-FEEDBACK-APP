# DEV-68 — Required Survey Answer Integrity

**Authorization:** Development-only; no production environment, settlement, credit, loyalty or billing writes.

## Evidence-based gap
`SurveyParticipationService.submit` checks that required question IDs are present, and `assertAnswerValue` checks type and optional published limits. A required text/textarea question nevertheless accepted empty or whitespace-only strings when `minLength` was not configured; a required multi-choice question accepted an empty list.

## Scoped implementation
- Existing pure `assertAnswerValue` is exported for direct regression testing; its runtime call sites and error codes remain unchanged.
- Required text/textarea values must contain a non-whitespace character.
- Required multi-choice values must contain one or more allowed, nonduplicated options.
- Existing optional blank text and optional empty multi-choice answers remain valid.
- Existing numeric zero and Boolean false remain valid. Other published length, numeric bounds and option checks are preserved.

## Evidence
`survey-answer-required.dev68.test.ts` covers required/optional and positive/negative cases. Full CI and integration verification remain required.

No survey version migration, reward linkage, completion-event change, financial activation or external provider calls.
