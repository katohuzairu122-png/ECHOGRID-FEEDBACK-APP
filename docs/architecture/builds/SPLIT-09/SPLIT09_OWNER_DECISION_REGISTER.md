# Split 09 — Owner decision register and implementation boundary

Date: 2026-11-27  
Baseline inspected: `1c6db612a1bce61e935c3aa591059dcac76e2384`  
Purpose: record the policy decisions that prevent safe implementation or activation of the remaining B2B network. This register does not approve a policy.

## Locked rulings carried forward

| Decision | Binding ruling | Implementation consequence |
| --- | --- | --- |
| S9-D1 | Platform enrollment plus explicit business acceptance of B2B terms; profile publication alone is insufficient. | Existing service and database guard remain authoritative. Enrollment is fail-closed without an active terms version and valid acceptance receipt. |
| S9-D2 | BDPN-01 owns the single business profile entity; Split 09 extends it. | No second listing/profile entity may be introduced. |
| S9-D8 | Structured categories and short free-text descriptions; no media in v1; reuse approved BDPN taxonomy/content restrictions. | Resource/service taxonomy and listing validation depend on an approved taxonomy and content policy. |
| S9-D12 | Prefer per-block migrations, subject to migration-governance reconciliation. | No shared migration was executed. Current journal ends at 0107; a new identifier must be rechecked on the branch used for implementation. |

## Decisions required

| Decision | Recommended resolution for Owner review | Consequence / dependency |
| --- | --- | --- |
| S9-D3 — request limits, cooldown, expiry | Define maximum new requests per requester and per counterparty over a fixed window, retry cooldown after decline/withdrawal, and expiry. Keep request creation disabled until the exact values and limiter failure behavior are approved. | Blocks safe partnership request creation and expiry jobs. No numerical values are inferred in this branch. |
| S9-D4 — approval authority | Require a counterparty business-wide owner/authorized manager to accept; platform staff may not impersonate either business. | Blocks acceptance endpoint and partnership activation until the exact role/permission is approved. |
| S9-D5 — partnership capabilities | Approve visibility-only as the initial capability; do not grant customer, loyalty, points, settlement, survey-response, credit, billing or marketing access by implication. Add any later capability only under its own contract. | Prevents active relationships from becoming a cross-tenant data or financial entitlement. |
| S9-D6 — termination and retention | Decide who can terminate, whether unilateral termination is immediate, resulting status, re-request rules, and retention treatment for immutable events. | Blocks terminal lifecycle transitions and any expiry/deletion policy for relationship evidence. |
| S9-D7 — messaging | Defer messaging in v1; if later approved, require separate B2B conversation storage, retention and platform-access rules. | No B2B message tables or customer conversation reuse. |
| S9-D9 — notifications | Approve in-app notifications only for lifecycle changes, with recipient rules and preference handling. Keep email/SMS/push disabled absent separate authorization. | Blocks notification writers and delivery records until approved event/recipient semantics are set. |
| S9-D10 — moderation and suspension | Restrict state-changing moderation to platform admins, require reason codes, preserve append-only audit evidence, and define review/appeal behavior. | Blocks listing and partnership suspension/reinstatement routes; the current participation service's provisional admin suspension remains a policy assumption. |
| S9-D11 — subscription eligibility | Decide whether participation or directory visibility is universal or plan-gated, and what downgrade does to existing records. | Blocks any plan-entitlement predicate. Do not read/write Partner Credits or billing as a substitute. |
| S9-D13 — research and shared data | Keep cross-business research and shared/private data out of v1. Any future sharing requires purpose, consent, aggregation and retention contracts. | Active partnership grants no access to customer data or survey responses. |

## Additional prerequisites

| Topic | Current state | Required before activation |
| --- | --- | --- |
| B2B terms text/version | Terms table is empty by design; no approved text/version was found in the repository. | Owner-approved exact text, version and digest, effective date, version activation authority and customer/business-facing display contract. |
| Acceptance permission | Existing service uses `billing:manage` as an explicitly provisional assumption; no B2B permission catalog is approved. | Owner selects or ratifies the business acceptance authority. Never seed `b2b:view/manage/moderate` keys by inference. |
| Acceptance receipt validity | Service uses a 24-hour freshness check copied from Split 07; B2B has no ratified receipt lifetime. | Approve the validity interval or direct the service to use a different rule before exposing acceptance. |
| BDPN content/moderation | Interim content policy remains a draft; the resource/service taxonomy is not present as an approved contract. | Approve the allowed category catalog, description limits and moderation policy before B2B profile revisions can be submitted or published. |
| Business identity verification | BDPN profile storage exists; the reviewed branch has no single completed B2B verification contract to rely on for directory eligibility. | Specify the authoritative verification state/source and what happens on loss of verification. |

## Implemented independent work on the B2B branch

- Added authenticated `GET /b2b/participation`, scoped to the caller's own business and business-wide tenant context.
- Added bounded, admin-only, read-only `GET /platform/b2b/participations` oversight.
- Both responses are `no-store`; neither endpoint creates or changes participation.
- Existing `0081` schema, guards and service remain unchanged. No migration, provider, financial, loyalty, Community or production operation was added.

## Activation boundary

Participation remains fail-closed until approved terms and an independently authorized enrollment/acceptance path exist. The directory, listing extension, partnership lifecycle, moderation writes, notifications, messaging and collaboration capabilities must remain unavailable until their listed policy and technical prerequisites are resolved. A business partnership, once approved, still grants no customer-data, loyalty, billing, Partner Credit, settlement or advertising access by default.
