# DEV-69 — Unique Survey Question Options

**Authorization:** Development only; no retroactive survey data migrations or runtime activation.

## Evidence-based gap
`surveyQuestionInputSchema` required a nonempty options list for single/multi-choice questions but allowed the same option more than once. The schema trims option strings, so repeated labels (including whitespace variants) could be published and make answer interpretation ambiguous.

## Scoped implementation
- The shared `surveyQuestionInputSchema` adds a uniqueness check for normalized options, including the offending option index in the Zod error path.
- Applies to single_choice and multi_choice only; all other question types retain their existing constraints.
- New `survey-options-unique.dev69.test.ts` exercises duplicates, normalization, allowed distinct choices, and createSurveyVersionSchema composition.

## Boundaries
This is a *publication input* contract. Existing immutable published versions are not mutated. It does not implement new survey answer handling, reward eligibility or financial effects.

Full exact-head CI and independent owner review required before merging.
