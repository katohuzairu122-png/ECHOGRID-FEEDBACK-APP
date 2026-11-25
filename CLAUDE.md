# Project instructions (authoritative, repository root)

This file records standing project rules. It does not replace the architecture documents under `docs/architecture/`, which remain authoritative for their own areas (frozen specifications, authorization model, migration governance in `docs/MIGRATION-GOVERNANCE.md`).

## Brand: Echo Grid -> Tentaship

Tentaship is the complete and indivisible successor brand name of Echo Grid.

The standalone Tenta naming convention has been abandoned.

Approved feature names are Tentaship Badges, Tentaship Shuffle and Tentaship Drops.

All new development must use the approved Tentaship naming convention.

The existing Echo Grid graphical logo, colour palette, typography and design system are protected brand assets.

The transition is a naming migration only.

Existing infrastructure, identifiers, legal references, compatibility contracts and historical evidence must remain intact.

Full naming migration is reserved for BRAND-01 and requires separate authorization.

Continue the existing development roadmap without restarting completed work.

Details, protected identifiers and the registered workstreams: `docs/architecture/builds/TENTASHIP/TENTASHIP_00_BRAND_POLICY_AND_ROADMAP.md`.

## Standing release rules

- The Owner merges pull requests. Do not merge.
- Production or staging deployment, shared-database migration and feature activation require the Owner's explicit instruction.
- New randomized-reward, badge and sponsored-drop functionality is disabled by default behind its own independent controls (`TENTASHIP_BADGES_ENABLED`, `TENTASHIP_SHUFFLE_ENABLED`, `TENTASHIP_DROPS_ENABLED` as proposed; never `NETWORK_FEED_ENABLED`).
