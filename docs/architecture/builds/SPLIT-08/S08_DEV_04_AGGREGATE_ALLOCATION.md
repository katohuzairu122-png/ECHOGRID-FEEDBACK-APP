# S08-DEV-04 — Deterministic aggregate benefit allocation

**Project:** ECHO GRID — INFINICUS LLC  
**Execution date:** 2026-10-25  
**Policy:** S08-AGG-ROUND/1  
**Scope:** development only; pure immutable artifact, no persistence or financial authorization.

## Pre-implementation audit

Authoritative main: `9775ead06ec6a720fca64859786cc6a51f9876e0`. The workspace proxy could not clone GitHub, so sources were fetched by pinned SHA through the GitHub connector. An isolated Actions checkout fetched that exact commit and verified an empty `git status --porcelain` before implementation: [baseline audit](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/40197102252). No tracked AGENTS.md files were found.

Reviewed Split 07 foundations/frozen Partner Credit architecture, Split 08 CE-1 contracts, S08-PIC/1, owner timing/instrument decisions, HETA Block G identity rules, migrations 0047–0051, reservation/schema code, the existing calculator/saga/reconciler and associated tests.

Compatibility findings:

- Existing PC-BENEFIT/1 already calculates the aggregate with BigInt and one floor. The new component validates and preserves that result; it does not introduce another invoice eligibility policy or tax calculation.
- Existing multi-unit helpers model credit-unit accounting under a different proposal. They are not a monetary residual allocator and are not reused or activated.
- Migration 0047 composite tenant keys, 0048 one-unit/positive-benefit constraints, 0049 evidence safeguards, 0050 dispute/dual-control guards and 0051 HETA foundations remain unchanged.
- The current calculator still has a paid-invoice eligibility default. This block accepts a validated eligible calculator result and does not rewrite that gate, infer draft eligibility or manufacture approval. Future draft-invoice eligibility integration remains separate.
- The current reservation key is unique per business/invoice-intent; terminal applications are unique per business/invoice and one-unit. This artifact does not bypass those constraints or provide an integrated multi-credit writer. Any future persistence/application design must resolve those constraints under separate authorization; this module must not be wired directly into that path.
- No architecture conflict exists within the authorized pure-artifact scope. Provider, reservation, ledger and frozen state-machine semantics are untouched.

The owner's S08-DEV-04 instruction explicitly approves aggregate rounding and deterministic positive allocation for development. It resolves that allocation design only, without approving tax, settlement or final accounting.

## API and trust boundary

`freezeAggregateBenefitAllocation(input)` returns a Promise of a deeply immutable `FrozenAggregateBenefitAllocation`. Hashing uses local Web Crypto SHA-256; there is no I/O.

Input:

- A validated invoice binding (business UUID, explicit invoice reference, currency).
- An eligible PC-BENEFIT/1 calculator result, including its original aggregate.
- Validated eligible capacity for the batch, including its already-reserved units. This is not the post-reservation `accounts.available` value.
- Persisted reservation identity snapshots, with original distinct invoice-intent references, validated invoice/currency bindings, one unit, reserved state and explicit no-provider-attempt evidence.
- Exact supported allocation policy version.

The invoice/currency and attempt fields are a server-validated projection, not new database columns. The function validates structural consistency but cannot prove a row exists, authenticate a caller, establish current balance/expiry/dispute authority or verify a provider. A fabricated tuple never gains financial authority through this component. The caller must obtain and authenticate these inputs separately.

Reject duplicate/noncanonical/missing IDs, duplicate business/invoice-intent identities, tenant/invoice/currency mismatches, non-one-unit or terminal reservations, attempted-provider states, unsupported policy versions, invalid/unsafe amounts, zero/over-ten batches, insufficient eligible capacity and tampered aggregate results.

Every success returns literal `providerVerified: false` and `consumptionAuthorized: false`. Typed rejection errors carry the same false flags.

## Algorithm and evidence

Let B be the validated eligible base in minor units and N the number of distinct one-unit reservations, 1–10.

1. Validate that the supplied calculator aggregate A equals `floor(B × N × 1 / 100)`, with BigInt throughout currency arithmetic, and that it does not exceed 10% of B.
2. Sort canonical lowercase persisted reservation UUIDs by code units; this is byte-equivalent hexadecimal ordering, independent of locale, execution time and input/database order.
3. Compute equal share `q = A / N` and remainder `r = A % N` using integer division.
4. Reject the entire batch if q is zero. Do not drop reservations, rebalance a partial attempt or silently select fewer credits.
5. Assign q+1 to the first r sorted IDs and q to the rest.
6. Verify positive safe-integer shares and exact BigInt conservation.
7. Copy and freeze every entry, the allocation array and artifact body before hashing. No caller-owned object is retained across the async digest step.
8. Return the frozen artifact with its deterministic digest.

For B=199 and N=2: A=3, q=1, r=1; the lowest ID receives 2, the next receives 1. The original provider key remains `benefit-apply:v1:<reservationId>`.

The artifact supports safe-integer monetary amounts even where current inert PostgreSQL amount columns are int4. It does not authorize storing out-of-range values; future adapters must enforce their destination limits under a separate approved design.

## Canonical digest contract

`allocationDigest` is lowercase hex SHA-256 of UTF-8 JSON for this fixed positional tuple:

```text
[
  "ECHO-GRID:S08-AGG-ROUND:artifact/1",
  allocationPolicyVersion, benefitPolicyVersion,
  businessId, invoiceRef, currency,
  eligibleBaseMinor, eligibleCreditBalance,
  unitsToApply, aggregateBenefitMinor, percentApplied,
  false, false,
  [
    [reservationId, invoiceIntentRef, 1, benefitMinor, providerIdempotencyKey],
    ...
  ]
]
```

Entries are in canonical ID order. Field positions and domain/version are explicit; arbitrary delimiter concatenation, timestamps, random values, locale collation and object property ordering are not used as identity. The full artifact remains available for comparison; the digest is not a signature, HETA attestation, persistence guarantee or proof of provider success.

For the documented unit fixture (business `11111111-1111-4111-8111-111111111111`, invoice `in_fixture`, USD, base 199, capacity 2, reservations `00000000-0000-4000-8000-000000000001/2`, intent_1/intent_2), the digest is:

`c39e7b123edd65a71724872476b56fa860bda42a75a0abe5f8c2df573195a016`

## Freeze limitation

Freeze is an in-memory immutable representation only. It is created before provider attempts according to validated input snapshots; no durable lock, DB uniqueness, retry record or provider call is created. A future service must durably bind an approved artifact before any separately authorized operation, compare its full content on replay and revalidate live authority. None of that future service is implemented here.

## Validation and release restrictions

Local Node 24 invariant harness: 6 passed, 0 failed, including 1,000 generated cases, independent SHA-256 encoding, reference allocation, MAX_SAFE_INTEGER and mutation checks. It used Node's TypeScript transform plus an extension-resolving loader to execute the unchanged source; it was not a Vitest or repository typecheck run. The workspace has no installed repository dependencies and its proxy is unreachable.

Repository Vitest cases cover all 24 requested categories, with deterministic generated properties and no new dependencies. Applicable CI supplies actual repository TypeScript, lint, unit/regression, schema and disposable PostgreSQL checks; its result must be reported separately rather than inferred from local checks.

No new schema or migration, no database/persistence code, no actual Stripe calls, ledger consumption, financial compensation, Neon operations, Cloudflare deployment, routes, cron, queues, new entitlements, guard changes or financial activation. Production certification is withheld. Tax, detailed settlement evidence and final consumption/compensation accounting remain separate decisions. Stop after S08-DEV-04.
