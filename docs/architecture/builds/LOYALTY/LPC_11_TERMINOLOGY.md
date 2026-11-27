# LPC-11: loyalty vocabulary (customer, cashier and business screens)

Status: implemented (wording only). **No qualification rule, tier threshold or earning rule was changed.**

## Glossary (English; es / fr / ar follow in the message files)
| Concept | Term | Meaning | Where it appears |
|---|---|---|---|
| The business's earning scheme | **Loyalty programme** | The one active scheme a business chooses (LP-01 to LP-07). Owner-only to change. | Business Loyalty > Programme; customer card title "Your rewards programme" |
| Joined a business | **Membership** | A customer's membership of a business; separate from the programme. The customer-facing phrase "loyalty program" for joining is kept as is. | Customer join, leave and wallet screens |
| Level by points | **Membership tier** | Reached by the points balance only; unchanged. Only points programmes (LP-02, LP-03, LP-06) move the balance. | Tiers screen, customer page ("N points to the X tier") |
| Spendable points | **Points balance** | Points held now. Always "points", never "pts". | Cashier card ("Points balance"), customer page |
| Progress toward a reward that is not points | **Purchase progress** | Stamps, milestone ladder, streak, mission progress | Customer programme card |
| Granted by the programme, not yet handed over | **Earned reward** | An entitlement waiting at the counter ("Rewards waiting for you" for the customer; "Earned rewards", Hand over, for the cashier) | Customer card, cashier scan |
| Catalogue reward the points balance can pay for | **Redeemable reward** | Shown with "Ready to redeem" or points still needed | Cashier card, customer page |
| Handed over | **Redeemed reward** | Final; cannot be repeated | Redeem screens, reversal warnings ("already handed over") |
| Time-boxed extra benefit | **Promotional benefit** | Not implemented (see LPC-12/13); no screen shows it | none |
| Undoing a purchase | **Reversal** (reward reversal when it withdraws an earned reward) | Owner and manager action; reward already handed over stays given | Business Loyalty > Purchases |

## Changes made
- Cashier card: "Points" becomes **Points balance**; "Rewards" becomes **Redeemable rewards** (en, es, fr, ar). Customer page: "Rewards" becomes **Redeemable rewards**; "N pts" becomes **N points**; "N pts to X" becomes **N points to the X tier**.
- A test pins that earned, redeemable and balance are three different words in each language, that the customer page and cashier card name the redeemable concept identically, that the programme-era namespaces never say "pts" or the US spelling "program", and that the four languages share the same keys.

## Open wording decision for the Owner
English mixes "program" (customer membership screens, existing) with "programme" (business-facing programme screens, new). Both were left as they are; unifying the spelling means changing about a dozen existing customer strings in four languages and needs your decision.
