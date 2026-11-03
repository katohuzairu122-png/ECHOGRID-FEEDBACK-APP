# S08 binding source freshness profile

Proposed on 2026-11-03 against main at `93ae3009c2bd5c4b0921f0077319fc06f01de254`. This profile narrows the open decisions in the [binding source contract](S08_AUTHENTICATED_BINDING_SOURCE_CONTRACT.md). It is ready for source and architecture review.

| Evidence | Permitted reliance | Required recheck |
| --- | --- | --- |
| Immutable observation and manifest | Identify exactly what the verifier received, under which account, mode and method | Compare the complete scoped identity, original evidence reference and digest |
| Account and realm attestation | Establish the context for that observation within the attestation's approved interval | Check current inventory, credential revision and incident restrictions |
| Business ownership and subscription lifecycle | Resolve the business and the applicable subscription and item for the requested interval | Check current permission, binding revision, and any conflicting or superseding evidence |
| Invoice state | Describe the invoice at observation time | Require independent evidence of any state relied on at commit |
| Historical assessment | Cover its exact scope and finite interval | Check the current assessment revision and unresolved challenges |

The proposed producer is a private billing verifier. The consumer resolves an immutable assertion reference using its authenticated business context. Each assertion binds the source method and version, full provider scope, business and invoice identity, evidence manifest, observation time, and applicable validity bounds. The consumer separately checks its current permission.

Evaluate validity on a trusted server clock. Treat intervals as half-open. A decision expires at the earliest applicable source, assertion or configuration end. At the final local transaction check, compare the binding, configuration, incident and permission revisions with the evaluated revisions. Missing or unavailable revisions, a changed head, ambiguous scope, or an expired interval deny reliance. A retry resolves the same request identity again. Preserve previously recorded evidence and existing reconciliation obligations.

## Evidence needed before relying on invoice state

A local revision fence can order local decisions. An authenticated invoice read provides an observation. To permit an operation that depends on current provider state, identify the specific provider guarantee that covers the interval from observation to acceptance. Record the method, its supported account and mode, clock uncertainty, and how the guarantee is verified. If the only evidence is a read at a point in time, retain it as audit evidence and deny commit-dependent reliance.

The owner and architecture reviewer must select the supported source method and its evidence-backed validity and skew limits. Until those are recorded, the profile has no usable operational validity duration. Allocation results retain literal false provider verification and consumption authorization.

## Acceptance examples

- An assertion used exactly at its earliest validity end denies reliance.
- An incident recorded after observation and before the local fence denies reliance even if the assertion is within its time interval.
- A changed invoice after a valid read remains an unresolved provider race despite a successful local fence.
- An unchanged invoice ID under a different provider account, mode, business or subscription item fails scope comparison.
- A durable historical assessment can remain available for audit after revocation while new reliance is denied.

These are proposed acceptance cases. The existing 144 fixture checks establish component behavior. Implementing this profile requires approved source evidence and a restricted transaction boundary under the [append capability contract](S08_APPEND_CAPABILITY_CONTRACT.md).
