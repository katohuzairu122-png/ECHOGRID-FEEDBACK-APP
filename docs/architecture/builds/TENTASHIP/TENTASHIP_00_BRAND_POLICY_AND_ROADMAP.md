# TENTASHIP-00 — Incremental brand policy, workstream registration and decisions

Status: REGISTERED (documentation only). Baseline: main `1af1d5b` (BCOMM-01 merged). Authority: Owner directives "Incremental Brand Transition", "Brand Identity Preservation" and "Brand Correction, Owner Rulings and Development Continuation" (2026-11-25; the last supersedes the earlier "Tenta" naming). No code, schema, infrastructure, domain or legal-entity change is made by this document.

## 1. Brand policy

- **Tentaship is one complete, indivisible brand** (Owner ruling 2026-11-25). The standalone "Tenta" prefix and any "Ship" product identity were proposed and are **abandoned**; they must not appear in new content, feature names or control names. Naming transition only: Echo Grid / EchoGrid -> Tentaship, echogrid -> tentaship, applied to **brand references only** (not technical terms, internal identifiers or compatibility contracts).
- **Approved feature names:** Tentaship Badges, Tentaship Shuffle, Tentaship Drops. Roadmap identifiers (TB, TSH, TDP, BRAND) are internal and keep their short form.
- New or substantively modified user-facing content uses **Tentaship** and the feature names **Tentaship Badges, Tentaship Shuffle, Tentaship Drops**. No repository-wide replacement; unrelated files are not touched for naming.
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

1. **TB-01 + TSH-01 + TDP-01 as one architecture block** (design, no schema): shared qualification model, badge ledger design, drop model. TB-01, TSH-01 and TDP-01 are delivered as design documents by this PR (`TB_01_*`, `TSH_01_TDP_01_*`).
2. TSH-02 (referral attribution, reuses business-scoped `loyalty_accounts.referred_by_customer_id`, customer identity and deletion guards).
3. TSH-03 + TSH-08 (campaigns, snapshots, governance) then TDP-02.
4. TB-02/TB-03/TB-04 may be consolidated into two blocks (engine, then interfaces + compatibility acceptance).
5. TSH-04 + TSH-05 + TSH-06, then TDP-03, TSH-07 + TDP-04, finally TSH-09.
   Mandatory unfinished work (Community readiness, deletion, cashier acceptance, security readiness) keeps priority over this order.

### Community placement (no duplicate top-level tabs)

COMMUNITY -> Feed, Tentaship Badges, Tentaship Shuffle, Tentaship Drops, Referrals, Membership, Notifications. Customer and business experiences stay separate (business hub today: Home / Participation / My Posts / Insights). Cashiers never inherit owner/manager permissions. Every new surface sits behind existing membership, consent, enrollment and restoration controls plus its own control.

### Independent feature controls (proposed names, verified NOT implemented in code/config on main; absent = off; exact "true" = on)

`TENTASHIP_BADGES_ENABLED`, `TENTASHIP_SHUFFLE_ENABLED`, `TENTASHIP_DROPS_ENABLED`; each campaign additionally has its own status. `NETWORK_FEED_ENABLED` is never reused. No participant may buy Shuffle entries, stake points or wager badges.

## 4. Owner rulings and unresolved decisions

Owner rulings (2026-11-25), recorded in full in TB-01 §6 and the TSH-01/TDP-01 design: **D-1** legacy Community Points preserved, never silently converted, read-only compatibility, retirement needs a separate approved policy; **D-2** Tentaship Badges use a separate append-only achievement ledger; **D-3** two disclosed campaign modes (A guaranteed, B limited), immutable after acceptance; **D-4** accurate allocation and odds disclosure, no misleading odds or animation; **D-5** reversals: recalculate before allocation, no silent revocation afterwards, no automatic debt; **D-6** campaign group size is configurable (minimum, maximum, windows, deadlines, closure, cancellation), never hardcoded.

Residual ambiguity: D-6 sets configurable _campaign_ sizes; the minimum group size for privacy-protecting _aggregate analytics_ (BCOMM-02) is a separate, still-unanswered decision.

Still unresolved (not marked complete): legal L-1 permitted jurisdictions; L-2 promotional competition / lottery / gambling classification (a free reward or free entry does not by itself settle it; purchase-based qualification needs a specific assessment); L-3 consumer protection; L-4 terms, age, free-entry alternative; L-5 privacy and marketing consent; L-6 tax and fulfillment. Operational: fraud ownership and thresholds, dispute authority, fulfillment SLAs, suspension and reward-cancellation authority, sponsorship obligations, Tentaship domain status, trademark clearance, legal entity naming status.

## 5. Brand-name hygiene check for this block

New content in this block (this document, TB-01 doc, CLAUDE.md) uses Tentaship terminology; no existing source, asset, token, route, schema or config file is modified.
