# Echo Grid repositioning — proposal A (Claude)

**Status: PROPOSAL FOR OWNER DECISION. Documentation only. No code, copy, translation, configuration, release or legal wording is changed by this document.**
Purpose: give the owner one proposal to compare against a second independent proposal (ChatGPT) and finalise a single direction.
Author note: written by Claude; it is a recommendation, not an independent review and not legal or regulatory advice.

## 1. Recommendation in one paragraph

Stop describing Echo Grid as a feedback app. Position it as **a loyalty network: one account, every loyalty.** Customers keep one account and one wallet for the loyalty programmes of every business they like. Businesses turn visits into loyal customers, hear them, and (later) get discovered. Feedback stays, but as the engine inside the loop, not the identity. Avoid the word "marketplace".

## 2. Why change

- Today's public message ("Turn Every Visit Into Lasting Value", "Collect Feedback", "Understand Insights") describes a business tool for one business. It does not show the strongest thing already built: **one customer account across many businesses**.
- The capability set has outgrown "feedback": loyalty and QR service, surveys, a Community Hub with points, settlements, a business discovery design, and cashier workflows.
- A bigger purpose is a stronger story for both sides, but only if every claim is true on the day it is published.

## 3. Positioning statement (draft)

> For people who shop and dine at many places, Echo Grid is the loyalty network that gives you **one account for every loyalty**. For businesses, it turns visits into loyal customers and honest feedback, in one platform.

### Name and tagline options (owner choice; no rename of the company or product is proposed)

| #     | Option                                             | Note                                                       |
| ----- | -------------------------------------------------- | ---------------------------------------------------------- |
| 1     | **Echo Grid — the loyalty network**                | Recommended. "Grid" already suggests a network.            |
| 2     | Echo Grid — one account, every loyalty             | Strongest customer line; good for the hero.                |
| 3     | Echo Grid — where customers and businesses connect | Softer, less specific.                                     |
| Avoid | "marketplace", "customer service platform", "B2B"  | Implies buying/selling, a helpdesk, or the wrong audience. |

## 4. Two audiences, two promises

| Audience   | Promise                                                                                               | Proof points available now                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Customers  | One account and one wallet for the loyalty of every business you like. Scan once, earn, have a voice. | One customer identity across businesses; per-business loyalty accounts; language choice (en/fr/es/ar) |
| Businesses | Turn visits into loyal customers, hear them, grow.                                                    | Branch QR, loyalty and rewards, feedback and surveys, cashier "Serve customers" workflow              |

Front page leads with **customers** (the wallet); businesses get their own page ("For Businesses") with the operating story. Reason: the network is the differentiator and it is a customer-side idea; businesses join because customers are there.

## 5. Message hierarchy

1. Headline: **One account. Every loyalty.**
2. The loop: **Visit → Earn → Say → Return → Get discovered.**
3. Feedback and surveys: "Your voice improves the places you love, and earns you rewards."
4. Trust: "Your data stays with each business you join. You control what is shared."
5. For businesses: "Loyalty, feedback and customer understanding in one place."

## 6. Claims policy: say only what is true on publication day

| Capability                               | State at last verification                        | Public wording                             |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| Loyalty accounts, QR service, rewards    | Built and deployed (release pinned `b2f85ac`)     | Say it                                     |
| Feedback and surveys                     | Built and deployed                                | Say it                                     |
| One customer account across businesses   | Built                                             | Say it, with the privacy line              |
| Customer language selector               | Deployed (cookie-based)                           | Say "four languages"                       |
| Cashier workspace hardening              | In `main` and draft PR #369; **not deployed**     | Do not mention                             |
| Community Hub / points                   | Read-only hub merged; points economics undecided  | "Coming" only; no point values or promises |
| Business discovery                       | Design only, off by default, activation undecided | "Coming"; no dates                         |
| Partner Credits, ads, financial features | **NO-GO**                                         | Do not mention                             |

Every public statement is re-checked against deployed behaviour before release. No timeline, ranking, earnings or "free rewards" claims.

## 7. Trust and privacy principles (non-negotiable for the pitch)

- One account does **not** mean businesses see each other's customers. Each business sees only its own members.
- Customers choose what to share; discovery never exposes personal data, only business profiles.
- No tracking of browsing in discovery; no selling of customer data; no hidden cross-business profiling.
- Consent and audit rules already in the product remain unchanged.

## 8. Plan in phases (each its own authorized block)

| Phase | Content                                                                                                                                         | Gate                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 0     | Owner decides positioning, name option, audience order, claims table                                                                            | Owner decision                                                    |
| 1     | Public copy: landing hero, "For Customers" and "For Businesses" pages, metadata description, PWA manifest text, onboarding wording; en/fr/es/ar | Owner approves wording per language                               |
| 2     | Customer wallet clarity in-app (a single "My loyalties" entry point and empty-state copy)                                                       | Separate authorization                                            |
| 3     | Discovery switched on (internal, then wider) per the BDPN plan                                                                                  | Separate owner gate; content policy and moderation staffing first |
| 4     | Network growth: city or sector clusters, business referral, shared-reward programmes                                                            | Economic policy decisions (points, Partner Credits) come first    |

Phases 3–4 do not start because Phases 0–2 are approved.

## 9. Go-to-market note (cold start)

A network is valuable only with density. Launch in one city or sector cluster, give early businesses a reason to join with few customers (loyalty and feedback value on their own), and give customers a reason to keep one account (a visible wallet with several businesses, not one).

## 10. Risks and mitigations

| Risk                                                                       | Mitigation                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Over-claiming features not live                                            | Claims table in section 6, checked before every release            |
| "Marketplace" triggers payments, consumer-law and advertising expectations | Avoid the word; no purchase or advertising features implied        |
| Privacy fears about one account                                            | Lead the trust story; explain per-business data separation         |
| Network too thin at launch                                                 | Cluster launch; businesses benefit without a network               |
| Brand confusion (feedback to loyalty to network)                           | One headline, one loop, retire old "feedback" hero lines gradually |
| Cashier and staff UX regress                                               | Positioning work is public-facing; no operational flows change     |

## 11. Measures of success (proposed)

- Customer: share holding loyalty with two or more businesses; repeat visit rate; account creation completion.
- Business: onboarding to first QR scan; active businesses per cluster.
- Message: landing conversion split by audience; support questions saying "what is this?"

## 12. Decisions required from the owner

1. Positioning line (option 1, 2 or 3 in section 3) and whether to keep "feedback" as a visible pillar.
2. Which audience leads the front page.
3. Whether "coming soon" mentions of discovery and Community are allowed publicly.
4. Whether to touch app-store, PWA and social descriptions in the same block.
5. Wording approval per language (en/fr/es/ar).

## 13. How to compare this with the second proposal

Score each proposal 1–5 on: clarity of the one-line positioning; truthfulness against deployed features; privacy and trust story; audience order justification; avoidance of regulated-claim traps; phased, gated plan; copy and translation effort; reversibility. Merge the best headline, claims table and phase plan into one final document, then authorize Phase 1.

## 14. Out of scope here

Code changes, new features, pricing, points economics, Partner Credits, legal terms, company or product renaming, and any release.
