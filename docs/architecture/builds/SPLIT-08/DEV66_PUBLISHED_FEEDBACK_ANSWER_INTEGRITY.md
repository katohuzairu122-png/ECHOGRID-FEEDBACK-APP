# DEV-66 — Published Feedback Form Answer Cardinality and Integrity

**Authorization:** Development only. Public feedback validation only; no reward/settlement authority.

## Verified baseline gap
`validateFeedbackAnswers` allowed an empty value for required text questions and empty `multi_choice` arrays for required questions. It also allowed repeated choices and arrays larger than the configured option vocabulary, producing misleading persisted feedback answers.

## Implementation
- Required text/textarea answers must contain at least one non-whitespace character; optional empty/whitespace text remains allowed, retaining previous optional semantics.
- Required multi-choice answers must select at least one option.
- All selections must be strings from the published question's configured options, with no repeated selections and no more selections than published options.
- Optional unanswered multi-choice questions (missing or empty list) remain valid.
- Added tests for duplicates, unknown/malformed choices, required empties and valid optional/required controls.

## Boundary
No changes to form publication schemas, versioning, idempotent submission keys, fraud controls, rewards, privacy, logging or database writes. Existing forms are validated against their immutable published options.

**Verification:** Exact-head CI and owner review; no production certification.
