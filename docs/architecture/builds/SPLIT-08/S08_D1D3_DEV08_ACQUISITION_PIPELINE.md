# S08 D1/D3-DEV-08 — Stripe read-only evidence acquisition pipeline (development record)

Status: DEVELOPMENT ONLY, INERT. Financial activation: NO-GO. No migration, no provider call outside tests (scripted transport, injected fetch, fixtures), no database write by the pipeline. Code: `apps/api/src/billing/stripe-read/`.

## Flow
`EvidenceAcquisitionPipeline.run({ businessId, invoiceId })` →
1. request check: only those two ids; any other property (verdict, completeness, mode, account, "verified", ...) is refused;
2. persisted tenant binding (`resolveBinding`): unknown invoice, another tenant's binding or a resolver failure is refused before any provider call;
3. real provider only: the private-verifier invocation contract (S08-PV05) for both operations; a real provider with none configured is refused (`INVOICE_REQUIRED` → `INVOCATION_REQUIRED`); a fixture provider needs none;
4. the shared evidence engine over ONE `ReadProvider`: preflight (capabilities, no provider call), account (must equal the expected account), invoice twice (bracketing reads, server-clock observation time), invoice-line pages, settling payment, refund history, dispute history, supplement; each category normalized with the DEV-07 normalizers; a provider failure ends the run with a safe failure class and no evidence;
5. completeness and freshness evaluation (`evaluateCompleteness`): blockers are incomplete, contradictory, schema drift, untrusted or real origin, freshness unavailable / from the future / stale. Any blocker → `REJECTED` (no classification handed over, nothing recordable); a real bundle is still shown to the classifiers so the refusal is theirs (`EVIDENCE_KIND_UNSUPPORTED`);
6. otherwise the existing classifier bridge runs the D1 settlement classifier (and D3 when a persisted payment reference is supplied) → `CLASSIFIED`, with `recordableEvidence` only for sealed MOCK_FIXTURE evidence.

## Providers
- `createRealReadProvider`: account and invoice over the GET-only transport behind the capability registry and the owner's `ReadAuthorization`; lines pagination, payment, refunds, disputes and the supplement are denied at runtime inside the provider (no transport call, an audit record each). A real bundle's other categories therefore stay UNRESOLVED; they are never filled from fixtures.
- `createMockReadProvider`: all six reads from synthetic fixtures. A provider is never a mixture of real and fixture facts.

## Refactor (one implementation)
`StripeReadOnlyEvidenceAdapter.acquire` (DEV-06) and `acquireMockExtendedEvidence` (DEV-07) are now thin wrappers over the engine; the trusted evidence service takes any `EvidenceAcquirer`. The DEV-06/07 suites pass unchanged except one assertion: the audit stream now also records the four runtime denials (and the event origin).

## Not verified / not built
No field mapping is verified against Stripe; the four reads are not authorized; there is no real evidence envelope, no source authenticity for real evidence, no key custody. Freshness (Q3) and the policy instant (Q14) are configuration passed through with no default. Q1/Q2, Q12, refund recovery and R10 are untouched. Real evidence cannot be recorded or consumed.
