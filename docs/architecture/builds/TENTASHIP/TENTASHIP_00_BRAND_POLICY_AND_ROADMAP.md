# TENTASHIP-00 — Incremental brand policy, workstream registration and decisions

Status: REGISTERED (documentation only). Baseline: main `1af1d5b` (BCOMM-01 merged). Authority: Owner directives "Tentaship — Incremental Brand Transition" and "Brand Identity Preservation" (2026-11-25). No code, schema, infrastructure, domain or legal-entity change is made by this document.

## 1. Brand policy

- Naming transition only: Echo -> Tenta, Grid -> Ship, Echo Grid / EchoGrid -> Tentaship, echogrid -> tentaship, applied to **brand references only** (not technical terms, internal identifiers or compatibility contracts).
- New or substantively modified user-facing content uses **Tentaship** and the feature names **Tenta Badges, Tenta Shuffle, Tenta Drops**. No repository-wide replacement; unrelated files are not touched for naming.
- **Protected visual identity** (no change under this directive or BRAND-01): logo symbol, colour palette and design tokens (`apps/web/src/app/globals.css`), typography, iconography, component styling, spacing, navigation patterns, animations, illustrations, public assets. New features inherit the existing design system.
- **Protected infrastructure and identifiers**: repository name/ownership, production and staging domains (incl. echo-grid.uk), Worker/Pages identifiers, Hyperdrive, Neon projects, schemas and identifiers, API routes/contracts, auth/session/cookies, env vars and secrets, OAuth, storage namespaces, webhooks, payment configuration, customer/business IDs, historical migrations, audit logs, consent records, legal entity (INFINICUS LLC), existing customer loyalty entitlements.
- Not assumed: that the Tentaship domain, trademark or entity registration is secured.
- Existing Echo Grid strings (about 75 web/API source files) stay until BRAND-01 is authorized. Legal text, consent records and historical evidence keep their original wording permanently.
- Directive reconciliation: the first directive names BRAND-01 "Full Brand Migration"; the later directive supersedes it as "Controlled Naming Migration" (naming only, logo/palette/design system preserved). This registry uses the later title.

## 2. Existing roadmap state (verified against main, not against historical reports)

- Merged: CUST-DEL-01/02 (deletion request and restore), COMMUNITY-FINAL-READINESS records, CF-READINESS-2 pilot control (migration 0090), CASHIER-CRED-01, BCOMM-01 (business Community hub, Community-first homepage).
- Still open (not started here): CUST-DEL-03 and BIZ-CLOSE-01 (start only on instruction); BCOMM-02..06 (proposed labels in BCOMM-01 doc); Owner-side items — legal/translation approvals, operators O-1..O-7, staging/production application of migrations 0088–0090, Cloudflare flag verification, cashier smoke test.
- Activation state: all Community controls remain off; nothing deployed or activated by this work.

## 3. Registered workstreams (identifiers reconciled: no collision with existing TB/TSH/TDP/BRAND ids)

| Id       | Scope                                                                                       | Depends on                                          |
| -------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| TB-01    | Community Points reconciliation, achievement architecture, migration design (see TB-01 doc) | none                                                |
| TB-02    | Verified achievement/milestone engine                                                       | TB-01, TSH-01                                       |
| TB-03    | Customer and business badge interfaces                                                      | TB-02                                               |
| TB-04    | Migration, compatibility, acceptance                                                        | TB-03                                               |
| TSH-01   | Qualification architecture and rule engine                                                  | TB-01                                               |
| TSH-02   | Referral attribution and fraud prevention                                                   | TSH-01                                              |
| TSH-03   | Campaign management, immutable rule versions, eligibility snapshots                         | TSH-01, TSH-02                                      |
| TSH-04   | Secure randomized allocation                                                                | TSH-03, TDP-02, Owner decisions D-3..D-5, legal L-1 |
| TSH-05   | Invitations and notifications                                                               | TSH-03                                              |
| TSH-06   | Customer and business Shuffle interfaces                                                    | TSH-04, TSH-05                                      |
| TSH-07   | Acquisition attribution and conversion analytics                                            | TSH-04, TDP-03                                      |
| TSH-08   | Governance, compliance, operational controls                                                | TSH-03                                              |
| TSH-09   | Independent end-to-end acceptance                                                           | all TSH, TDP                                        |
| TDP-01   | Sponsored product/service architecture                                                      | TB-01                                               |
| TDP-02   | Campaign inventory and sponsorship (atomic allocation)                                      | TDP-01, TSH-03                                      |
| TDP-03   | Collection and fulfillment verification                                                     | TDP-02                                              |
| TDP-04   | Sponsor analytics and acceptance                                                            | TDP-03, TSH-07                                      |
| BRAND-01 | Echo Grid -> Tentaship Controlled Naming Migration                                          | **REGISTERED — EXECUTION NOT AUTHORIZED**           |

### Proposed order and consolidation (to avoid fragmentation)

1. **TB-01 + TSH-01 + TDP-01 as one architecture block** (design, no schema): shared qualification model, badge ledger design, drop model. TB-01 is delivered by this PR.
2. TSH-02 (referral attribution, reuses business-scoped `loyalty_accounts.referred_by_customer_id`, customer identity and deletion guards).
3. TSH-03 + TSH-08 (campaigns, snapshots, governance) then TDP-02.
4. TB-02/TB-03/TB-04 may be consolidated into two blocks (engine, then interfaces + compatibility acceptance).
5. TSH-04 + TSH-05 + TSH-06, then TDP-03, TSH-07 + TDP-04, finally TSH-09.
   Mandatory unfinished work (Community readiness, deletion, cashier acceptance, security readiness) keeps priority over this order.

### Community placement (no duplicate top-level tabs)

COMMUNITY -> Feed, Tenta Badges, Tenta Shuffle, Tenta Drops, Referrals, Membership, Notifications. Customer and business experiences stay separate (business hub today: Home / Participation / My Posts / Insights). Cashiers never inherit owner/manager permissions. Every new surface sits behind existing membership, consent, enrollment and restoration controls plus its own control.

### Independent feature controls (proposed names, NOT created; absent = off; exact "true" = on)

`TENTA_BADGES_ENABLED`, `TENTA_SHUFFLE_ENABLED`, `TENTA_DROPS_ENABLED`; each campaign additionally has its own status. `NETWORK_FEED_ENABLED` is never reused. No participant may buy Shuffle entries, stake points or wager badges.

## 4. Unresolved decisions (none assumed)

Architecture: D-1 legacy Community Points fate (TB-01 §6); D-2 badge ledger shape; D-3 whether every participant wins or no-reward outcomes exist (must be disclosed); D-4 odds/availability display; D-5 qualification reversal rules (refunds, reversals, account deletion); D-6 minimum group size for aggregates.
Legal (L-1..L-6): jurisdiction assessment; promotion/lottery/gambling classification; consumer-protection and "free" claims; terms, age and free-entry alternative; privacy/marketing consent; tax and fulfillment responsibilities.
Operational: fraud-review and dispute owners and thresholds; fulfillment SLAs; campaign suspension authority; Tentaship domain/trademark/entity status.

## 5. Brand-name hygiene check for this block

New content in this block (this document, TB-01 doc, CLAUDE.md) uses Tentaship terminology; no existing source, asset, token, route, schema or config file is modified.
