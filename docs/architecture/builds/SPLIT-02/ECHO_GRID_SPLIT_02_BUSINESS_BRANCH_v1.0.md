# ECHO GRID — SPLIT 02
## Business & Branch
### Implementation Specification v1.0

**Status:** FROZEN FOR EXECUTION  
**Target repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`  
**Branch:** `architecture/split-02-business-branch`  
**Base:** Split 01 locked-complete branch @ `87e1b7924a31b740cdad277d81def59f51868273`  
**Master authority:** Echo Grid Master Architecture v1.0  
**Split:** 02 of 10

---

## 1. Purpose

Split 02 locks the tenant root, business-category authority, and subordinate branch model required by later loyalty, settlement, billing, and B2B splits.

Current repository foundations are strong and must be preserved:
- one business tenant root,
- many branches per business,
- business-scoped branch slugs,
- business/branch-scoped staff grants,
- tenant-aware branch repositories,
- soft-delete branch history,
- branch QR ownership.

This split is additive/hardening, not a rewrite.

---

## 2. Frozen target model

```text
BUSINESS
├── authoritative category
├── business-wide defaults
├── staff / roles
├── customer relationships
├── subscription
└── BRANCHES
    ├── operational location
    ├── staff scope
    ├── QR attribution
    ├── feedback attribution
    └── loyalty activity attribution
```

Hard rule:

```text
ONE BUSINESS = ONE TENANT
ONE BUSINESS → MANY BRANCHES
BRANCH ≠ TENANT
```

---

## 3. Repository audit classification

### KEEP
- `businesses`
- `branches`
- globally unique business slug
- branch slug unique per business
- branch repository requiring `businessId`
- branch-scoped RBAC
- tenant-context business membership check
- business/branch audit metadata
- soft deletion for branches
- branch QR ownership

### ADAPT
- business category: current free-text `industry` is insufficient for strict settlement matching
- branch lifecycle API: DB supports inactive/archived, shared update contract currently does not
- branch subscription limit: current plan-based branch cap conflicts with the locked model that branch count is not the primary subscription basis and branch limits remain commercially unresolved
- cross-field branch/business integrity should be strengthened where practical

### DEFER
- business exit execution/orphan creation → Split 06 Settlement & Clearing
- hosted-customer subscription migration → Split 08
- B2B resource/service profile → Split 09

---

## 4. Business category authority

Add a platform-owned category catalog:

```text
business_categories
- id
- key
- name
- group_key nullable
- description nullable
- is_active
- sort_order
- audit timestamps
```

Add nullable:

```text
businesses.category_id
```

Category key equality is the future strict settlement category test.

```text
Restaurant → Restaurant
Cafe → Cafe
Bakery → Bakery
```

Group membership such as `food_and_beverage` must NOT be used as a substitute for strict category equality in v1 settlement.

Existing `industry` remains as compatibility/free-form descriptive metadata and is not settlement authority.

---

## 5. Initial category catalog

Seed only categories already agreed in architecture:

```text
restaurant
cafe
bakery
fast_food
catering
salon
hotel
```

Group:
- restaurant/cafe/bakery/fast_food/catering → `food_and_beverage`

Do not infer categories for existing businesses.

Legacy businesses remain uncategorized until explicitly classified.

---

## 6. Business create/update contract

Business create may accept optional:

```text
categoryKey
```

Business settings update may accept optional:

```text
categoryKey
```

Server resolves category key to authoritative category ID.

Invalid/inactive category must fail cleanly.

Existing clients that omit category remain compatible.

---

## 7. Public/category discovery contract

Add read-only category listing suitable for onboarding/settings.

Business DTOs may expose:

```text
categoryKey
```

Do not expose internal category IDs where a stable key is sufficient.

---

## 8. Branch lifecycle

Current DB states are retained:

```text
active
inactive
archived
```

Update branch contract must permit explicit lifecycle change.

Soft delete remains distinct from archived.

Meaning:
- active → normal operations
- inactive → temporarily unavailable
- archived → historical/non-operational
- soft-deleted → internal removal state; not ordinary lifecycle UI

---

## 9. Branch subscription-limit correction

Current repository enforces `subscription_plans.maxBranches` in:
- BranchService
- migration 0031 DB trigger

Locked decision for Split 02:

**Remove active branch-cap enforcement from branch creation.**

Reason:
- branch count is not the primary Echo Grid subscription meter,
- exact branch limits were intentionally deferred,
- Split 08 will define hosted-customer billing and decide whether any secondary branch entitlement survives.

Compatibility:
- `maxBranches` columns may remain in billing schemas/UI until Split 08,
- but they must not block branch creation after Split 02,
- do not redesign Stripe/billing in this split.

Drop:
```text
branches_enforce_plan_limit trigger
echo_grid_enforce_branch_limit()
```

Remove BranchService dependency on subscription plan branch capacity.

Team-member limits are out of Split 02 scope and remain unchanged until their owning split reviews them.

---

## 10. Branch tenant integrity

Every branch repository operation must continue to require business scope.

Required invariants:

```text
branch.business_id = tenant business
branch-scoped staff grant must reference a branch belonging to same business
QR branch context must belong to same business
```

Where DB-level composite enforcement can be added safely without breaking existing data, add it.

If existing rows violate the invariant:
```text
STOP
REPORT
DO NOT SILENTLY REPAIR
```

---

## 11. Business lifecycle

Current statuses remain:

```text
active
suspended
archived
```

Do NOT add a customer-liability-destroying business-close endpoint in Split 02.

Reason:
business exit is economically consequential and must be integrated with orphan creation in Split 06.

Until Split 06:
- existing platform suspend/archive controls remain,
- no new tenant self-service permanent close action is introduced,
- `business:delete` remains unused as a destructive operation.

---

## 12. Prohibited shortcuts

Do not:
- create branch tenants
- make branch IDs globally authoritative without business scope
- use free-text `industry` for settlement category
- infer legacy business category from name/industry
- keep branch creation blocked by legacy `maxBranches`
- hard-delete branches as ordinary lifecycle
- implement business closure before settlement dependencies exist
- modify subscription prices/tier economics in Split 02
- weaken branch-scoped RBAC

---

## 13. Required tests

### Business
- business slug remains globally unique
- category key resolves to active category
- invalid category rejected
- uncategorized legacy business remains valid
- category update does not alter tenant identity

### Branch
- same slug allowed at different businesses
- duplicate slug rejected within same business
- branch create no longer fails because of `maxBranches`
- branch inactive/archive update works
- branch lookup cannot cross tenant
- branch-scoped role cannot access branch in another business
- archived/inactive branch history remains present
- soft-delete remains scoped

### Compatibility
- existing business creation still provisions owner role
- existing subscription provisioning still succeeds
- QR branch generation still succeeds
- existing branch CRUD clients remain compatible

---

## 14. Migration plan

```text
M1 create business_categories
M2 seed approved initial categories
M3 add businesses.category_id nullable
M4 add category FK/index
M5 drop legacy branch-limit trigger/function
M6 optionally add safe composite branch/business integrity constraint after validation
M7 update shared contracts/services/routes
M8 update tests
M9 run full CI
```

No existing business category is guessed.

---

## 15. Definition of Done

Split 02 is LOCKED COMPLETE only when:

- business category catalog exists
- businesses can be explicitly categorized
- legacy industry remains non-authoritative
- branch lifecycle can be updated
- branch creation is not blocked by legacy maxBranches
- tenant/branch isolation remains intact
- no business-close flow bypasses future settlement
- migration drift passes
- lint passes
- security gates pass
- API/web typecheck passes
- unit tests pass
- integration tests pass
- builds pass
- browser verification passes
- completion report exists

---

## 16. Conflict rule

If implementation conflicts with Master Architecture or this frozen Split 02 spec:

**STOP AND REPORT. DO NOT INVENT A WORKAROUND OR REDESIGN THE ARCHITECTURE FOR CONVENIENCE.**
