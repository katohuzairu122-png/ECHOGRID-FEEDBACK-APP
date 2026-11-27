# LPC-09: reward catalogue stays consistent with the programme

Status: implemented (API), validation pending Owner merge. No migration, no deployment, no feature activation.

## Gap found
The reward service knew nothing about programmes. An Owner could switch off, retype or delete a catalogue reward that the **active** programme pays out, or delete a reward customers had **earned but not yet received**, silently breaking the programme or stranding customers.

## Rules (`programs/reward-usage.service.ts`, applied by `PATCH` and `DELETE /loyalty/rewards/:id`)
| Change | Refused when | Error |
|---|---|---|
| Switch a reward off (inactive, paused) or change its type | the business's **active** programme's current configuration pays it out | 409 `REWARD_IN_USE_BY_PROGRAMME` (names the programme type) |
| Delete a reward | active programme pays it out, **or** customers have earned it and have not received it yet | 409 `REWARD_IN_USE_BY_PROGRAMME` / `REWARD_HAS_WAITING_ENTITLEMENTS` |
Drafts, validated and inactive programmes do not block (activation re-validates every reward reference); an unchanged status or type never triggers the check, so ordinary edits (name, description) are unaffected. Another business is never consulted.

## Findings recorded, no change made
- **Tiers** keep working on the points balance. Programmes LP-01, LP-04, LP-05 and LP-07 earn no points, so tiers only move for businesses on LP-02, LP-03 or LP-06 (or with a points balance from before). This is by design; the Owner screen should say so (open).
- **Promotional overlays** (time-boxed multipliers on top of a programme, stacking rules) need a written stacking and cap policy from the Owner before anything is built; nothing was implemented (see open items).

## Verification
API unit 4,601; 3 integration scenarios on PostgreSQL (active programme blocks, unused reward free, other business unaffected, switched-away programme frees deactivation, waiting entitlement blocks delete until handed over); tsc clean.
