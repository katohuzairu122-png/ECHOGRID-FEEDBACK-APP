# Project instructions (authoritative, repository root)

This file records standing project rules. It does not replace the architecture documents under `docs/architecture/`, which remain authoritative for their own areas (frozen specifications, authorization model, migration governance in `docs/MIGRATION-GOVERNANCE.md`).

## Brand: Echo Grid -> Tentaship

Echo Grid is the existing implementation identity. Tentaship is the approved target platform brand.

All new development must use Tentaship terminology in newly authored user-facing content.

Existing infrastructure, internal identifiers, legal references, historical evidence and compatibility contracts must remain intact until the relevant migration is authorized.

Tenta Badges, Tenta Shuffle and Tenta Drops are approved target feature names.

Full platform rebranding is reserved for BRAND-01 and must not be executed without separate Owner authorization.

Tentaship is the successor brand name of Echo Grid, not a replacement visual identity.

The existing Echo Grid logo symbol, colour palette, typography and design system are protected brand assets.

Only brand naming is changing.

All future development must preserve visual continuity while adopting Tentaship terminology.

Details, protected identifiers and the registered workstreams: `docs/architecture/builds/TENTASHIP/TENTASHIP_00_BRAND_POLICY_AND_ROADMAP.md`.

## Standing release rules

- The Owner merges pull requests. Do not merge.
- Production or staging deployment, shared-database migration and feature activation require the Owner's explicit instruction.
- New randomized-reward, badge and sponsored-drop functionality is disabled by default behind its own independent controls (never `NETWORK_FEED_ENABLED`).
