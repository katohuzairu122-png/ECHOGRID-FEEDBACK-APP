# ECHO GRID — SPLIT 02 REPOSITORY AUDIT
## Business & Branch

**Status:** COMPLETE  
**Audited base:** Split 01 locked branch @ `87e1b7924a31b740cdad277d81def59f51868273`

## Findings

| Area | Current repository | Classification |
|---|---|---|
| Business tenant root | one `businesses` row is tenant root | KEEP |
| Branch ownership | `branches.business_id` required | KEEP |
| Branch slug | unique per business | KEEP |
| Branch repository | businessId required on reads/writes | KEEP |
| Staff branch scope | business + optional branch grants | KEEP |
| Business category | free-text `industry` only | MISSING / ADAPT |
| Branch lifecycle | DB has active/inactive/archived; update contract omitted status | ADAPT |
| Branch subscription cap | application + DB trigger enforce maxBranches | ARCHITECTURE CONFLICT |
| Business permanent exit | no tenant-facing delete route; only platform suspend/archive | KEEP SAFE / DEFER EXIT TO SPLIT 06 |
| Business subscription provisioning | created transactionally with business | KEEP |
| Tenant database RLS | not implemented | DEFERRED PLATFORM HARDENING |

## Locked corrections

1. Add authoritative platform business category catalog.
2. Add nullable business category FK without guessing legacy classifications.
3. Expose category catalog and categoryKey on create/update contracts.
4. Permit explicit branch inactive/archive lifecycle changes.
5. Remove active maxBranches enforcement from branch creation and DB trigger.
6. Preserve existing maxBranches billing metadata until Split 08.
7. Do not implement permanent business exit until orphan-settlement dependencies exist.
8. Preserve current branch-scoped tenant authorization.
