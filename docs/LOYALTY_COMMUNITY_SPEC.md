# Echo Grid loyalty and community — locked decisions, version 1

Decision date: 2026-10-05. This records the business decisions agreed with the product owner. “Locked” means the decisions below are the implementation baseline, not that repository permissions or branch protection have been changed. Amend this document explicitly, with a version/date and rationale, when a product decision changes.

## Locked product rules

1. Customers use one phone-verified Echo Grid identity across businesses. Account identity, community participation and branch membership are separate concepts. A business-only experience does not create a second customer identity.
2. Businesses pay the platform subscription in both onboarding modes; customers do not pay to join. Final pricing and subscription branch limits will be decided after development and testing. This release does not replace the existing billing catalog.
3. Community participation by a business means public recognition/listing as a member business. It does not give that business access to other businesses' customer lists, phone numbers or feedback.
4. Business-only onboarding supports the business's own walk-ins and branding. Customers choose whether to stay in that experience or join the wider Echo Grid community. Community-connected onboarding explains and requires explicit acceptance of community enrollment. Scanning a QR is not consent by itself.
5. QR context comes from a verified, active server-side QR record. The customer cannot choose another branch by changing a body field. Feedback and membership enrollment use that exact branch.
6. A first qualifying paid purchase at the branch activates its loyalty membership. Starting enrollment or scanning a QR does not earn purchase rewards. Authorized staff confirm the purchase, receipt reference and qualifying units. Echo Grid records the purchase confirmation; it is not a card-payment processor.
7. Each branch has its own progress and reward balance. Qualifying products and how staff count qualifying units are explicitly described by the business. Units may represent stamps, qualifying items or a points conversion selected by the business. No purchase counting unit, expiry period or subscription price is silently assumed.
8. Rewards are normally earned and redeemed at the same branch. A customer's account shows each branch independently, its activation state, progress, reward and transaction history. A QR scan alone is not proof of a branch visit.
9. Purchase-linked feedback must belong to the authenticated purchaser and scanned branch, with an unrefunded staff-confirmed purchase. It may have any rating, including negative feedback. Purchase reward issuance does not depend on positive feedback or completion of a feedback form.
10. Non-buyers are survey participants. Their eventual Echo Grid survey points are a separate balance redeemable with participating partners. Survey participation does not activate a purchase loyalty membership or credit a business's purchase ledger.
11. Refunds reverse the associated granted reward units through a linked audit entry. Spent/reserved rewards need a reviewed settlement policy; do not silently create a negative balance, charge a customer or erase transaction history.
12. When a business closes or cancels, Echo Grid retains customer entitlements and arranges replacement settlement with willing partner businesses. The settling business receives a calculated discount on its next subscription after fulfilling the replacement reward. Neither a closed business's rewards nor partner obligations may be silently duplicated or erased.

## Delivered in this change

The branch purchase loyalty flow is additive to existing business loyalty:

| Area                  | Implemented behavior                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch program        | Owner/admin configuration of onboarding mode, member listing, qualifying purchase description, progress unit and reward threshold               |
| Customer onboarding   | Existing phone OTP account; explicit community choice; pending branch enrollment with membership QR                                             |
| Purchase confirmation | Staff permission and branch scope; receipt reference, qualifying units and evidence; first purchase activates membership                        |
| Balance               | Branch ledger is the source of truth; purchases credit units; redemption reserves units; refund appends linked purchase and feedback-bonus reversals                       |
| Redemption            | Customer-owned membership; same-branch staff fulfillment; idempotent reservation and confirmation                                               |
| Feedback              | Authenticated purchase evidence, branch/purchaser checks, one feedback per purchase, normal custom form validation, negative ratings allowed and configurable once-per-purchase feedback bonus |
| Community             | Published branch recognition directory and customer preference management                                                                       |
| Existing balances     | Original accounts and ledgers remain intact and accessible; no guessed branch allocation                                                        |
| Retention             | New entitlement records prevent hard deletion of their business/branch; archived or paused programs retain account history                      |

These are draft implementation changes until reviewed, migrated and deployed. They are not evidence of a production rollout.

An existing branch changes to this flow when its branch program is configured. Its former QR check-in endpoint then rejects scan-only purchase earning, including when the new program is paused. Unconfigured legacy branches retain their existing behavior during the transition. Historic business balances remain separate from new branch balances and retain their existing redemption flow; they are not presented as newly verified purchase rewards.

Progress, feedback bonus and reward terms become immutable after ledger activity. Mode, recognition and enabled/paused state remain editable. A future change in earning or reward promises requires a versioned successor program, rather than reinterpretation of earned units.

The initial staff UI accepts scanned/pasted membership IDs. In-browser camera scanning and receipt/POS integrations are follow-up improvements; staff confirmation is the current evidence mechanism. Purchase evidence is recorded, not automatically verified against a payment provider.

## Decisions still needed before financial activation

| Capability                | Required definition                                                                                                 | Current status                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Survey point issuance     | Who funds it, award rate, eligible survey/duplicate rules and issuance budget                                       | No survey point ledger or live issuance in this release           |
| Partner survey redemption | Point value, partner acceptance, settlement funding and quotas                                                      | Not implemented or activated                                      |
| Closed-business recovery  | Entitlement valuation, customer and partner acceptance, assignment/reservation, fulfillment and cancellation states | Entitlements retained; reassignment workflow not implemented      |
| Subscription compensation | Discount formula, caps, billing currency, funding and reversal treatment                                            | No calculated credit or invoice modification implemented          |
| Refund after spending     | Reviewed case workflow, liability and treatment of partial refunds                                                  | Explicit review-required error; no silent clawback                |
| Earning automation        | Product catalog, item/transaction/spend conversion and receipt/POS integration                                      | Business describes rules; authorized staff enter qualifying units |
| Program successors        | Preserved terms for old balances, successor campaign enrollment                                                     | Existing earned terms protected; successor authoring deferred     |
| Pricing and branch limits | Final subscription catalog and limits                                                                               | Deferred by product owner                                         |

Survey feedback is currently accepted through the existing anonymous feedback flow and has no linked purchase badge or points promise. Existing visit verification signals retain their original meaning; they are not relabeled as purchase evidence.

## Business balances moving to branch tracking

Example: a customer has 30 historic business points and no reliable receipt/QR attribution. The account keeps those 30 as an existing business balance. Joining Branch A starts a separate pending membership at zero; a confirmed qualifying purchase gives Branch A its own units. Branch B does not receive a copy of either balance.

A later reconciliation migration may attribute old transactions using trusted QR, visit or purchase records. It must preserve the original ledger, record each allocation once and reconcile before/after totals. Unknown attribution remains an explicit business balance. Never split arbitrarily, allocate to every branch, count historical scans as paid purchases or silently convert currencies/units.

## Architecture and data boundaries

Follow [ARCHITECTURE.md](./ARCHITECTURE.md), [ERD.md](./ERD.md) and [API.md](./API.md). The API owns data and transactions. Web Server Components/Actions call the API via the BFF pattern; customer tokens remain in httpOnly cookies. Customer identity and staff RBAC are separate.

`BranchLoyaltyService` owns transactions as the existing loyalty services do. Program row locks coordinate configuration with earning; membership row locks serialize purchase, redemption and refund operations. Receipt uniqueness is branch-scoped within a business. Customer-owned lookups and staff tenant/branch predicates are mandatory. New customer routes mount independently of staff middleware.

No destructive legacy migration is included. New tables use restrictive foreign keys to keep entitlements from being removed by business/branch hard deletion. Staff configuration, purchase, refund and fulfillment mutations set audit metadata. Receipt/evidence strings must not contain card credentials.

The ledger stores redemption reward names and costs at reservation time. Confirmation changes only fulfillment metadata. Refund is a compensating row referencing its original purchase. Retrying an identical receipt/request never issues a second reward. A conflicting receipt replay is rejected.

## Release gates and acceptance

1. Review schema and policy changes in the pull request. Apply the additive migrations in staging before deploying readers of the new schema. Production migrations remain an explicit release operation under the existing deployment policy.
2. Run workspace typechecks, migration drift checks, API and web suites and Worker/web builds. The embedded PostgreSQL suite executes the full committed migration chain without external credentials. CI must also run the existing Postgres integration suite.
3. Confirm new branch enrollment starts at zero; staff purchase activates the exact branch; another customer/branch cannot claim its purchase or reward; receipt/redeem retries do not duplicate units; refund restores the expected balance and history.
4. Verify OTP cookie handoff, branch landing, membership QR, staff confirmation, purchase feedback, dashboard refresh, reward reservation and staff fulfillment on staging mobile browsers.
5. Preserve and reconcile legacy balances. Do not run automatic production reallocation or a pricing change as part of deployment.
6. Enable branch programs deliberately. Complete the unresolved settlement/survey economics and their workflow tests before building and activating those financial features.
