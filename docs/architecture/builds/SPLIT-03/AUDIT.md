# ECHO GRID — SPLIT 03 REPOSITORY AUDIT
## Loyalty & Core QR Interaction

**Status:** COMPLETE

| Area | Current repository | Classification |
|---|---|---|
| Business-level loyalty account | present | KEEP |
| Append-only loyalty ledger | present | KEEP |
| Denormalized balance/visit projection | present | KEEP |
| Tiers/settings/reward campaigns | present | KEEP |
| Two-phase redemption | present | KEEP |
| Signed branch QR | present | KEEP / RENAME SEMANTICS |
| Purchase durability/idempotency | missing | ARCHITECTURE CONFLICT |
| Branch staff operational loyalty | globally blocked by business-wide middleware | ARCHITECTURE CONFLICT |
| Customer QR | missing | MISSING |
| Staff-side action resolver | missing | MISSING |
| Customer-side business QR resolver | missing | MISSING |
| QR semantic type | `feedback` despite shared use | ADAPT |

## Conclusion

Split 03 is primarily a hardening/interaction split. The economic foundation is already strong and must not be rebuilt.
