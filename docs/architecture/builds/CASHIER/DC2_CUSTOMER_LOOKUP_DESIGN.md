# D-C2: cashier customer lookup by phone or Echo Grid ID. Design

**Status: PROPOSED. DESIGN ONLY. DOCUMENTATION ONLY.** No code, migration, deployment or environment change is authorized by this document. Financial activation remains NO-GO.
Date: 2026-11-12. Baseline: `origin/main` at `9bf2b45e566caba896fd3a0554962e29d2bfb502`.
Authorship: written by Claude; not an independent review. Owner decisions are listed in section 9.

## 1. Request

After validating the cashier workspace on staging, the owner asked that the cashier Serve customers page offer only two ways to identify a customer: scan the customer's QR code, or enter the customer's Echo Grid ID or phone number. The photo-upload control was removed (PR #380). The manual path that remains takes a **QR token**, not an ID or a phone number. This document designs the missing lookup.

## 2. Verified current state

| Fact                                                                                                                                                                                                                                                                                                   | Evidence                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Customers are global. One row per phone number (E.164, unique). Names, email and birthday are optional.                                                                                                                                                                                                | `apps/api/src/db/schema/customers.ts`                                                       |
| Business membership is a separate row per customer and business, with its own loyalty account.                                                                                                                                                                                                         | `business-customer-memberships.ts`, `loyalty-accounts.ts` (unique on customer and business) |
| **No "Echo Grid ID" exists.** There is no public code or member number in the schema, the API or the customer UI. The customer's wallet shows a short-lived signed QR only.                                                                                                                            | grep of `db/schema`, `routes`, `apps/web/src` found none                                    |
| Staff identify a customer today by verifying a short-lived signed customer QR token (`/loyalty/actions/resolve-customer`, permission `loyalty:serve`). The resolver returns the customer id, the loyalty account id, the membership state and the allowed actions.                                     | `loyalty-action-resolver.ts`                                                                |
| Recording a purchase needs `loyalty:serve` and an **account id in the URL**. It does **not** re-check any customer proof. The account id is the capability: today a cashier only gets one by scanning a QR (the account list needs `loyalty:accounts:view`, which cashiers no longer hold after D-C1). | `loyalty.routes.ts`, `POST /accounts/:id/purchase`                                          |
| Redemption is two-phase. The customer redeems and receives a code; staff confirm the code at the counter.                                                                                                                                                                                              | `loyalty-redemption.service.ts`                                                             |
| Phone validation uses the E.164 pattern shared by customer auth.                                                                                                                                                                                                                                       | `packages/shared-types/src/customer-auth.ts`                                                |
| Rate limiting: a global `API_RATE_LIMITER` on every API route, plus dedicated limiters (OTP, public, follow-up question). Audit rows are written by the audit middleware from `auditMetadata`.                                                                                                         | `index.ts`, `wrangler.toml`, `middleware/audit.ts`                                          |
| The purchase channel enum is `branch, online, delivery, whatsapp, phone, other`. `phone` means a phone order, not "identified by phone".                                                                                                                                                               | `loyalty-purchase-events.ts`                                                                |

**Key finding.** A lookup that returns an account id from a phone number would be the first path that gives a cashier an account id **without any proof from the customer** (a scanned token). Everything in this design follows from controlling that.

## 3. Principles

1. A lookup never widens what a cashier can see. It is business-scoped membership only, never the platform customer table.
2. Minimum disclosure: the cashier sees what they need to serve, not a profile.
3. No enumeration: uniform answers, strict limits, every lookup audited.
4. Value leaving the business (reward redemption) always needs the customer's own proof.
5. No new broad permission: cashiers keep `loyalty:serve`. The lookup must not use or imply `loyalty:accounts:view`.
6. Labels must say exactly what the control does (the D-C1 lesson on "Search customers").

## 4. Proposed behaviour

### 4.1 Identifiers

- **Phone number (Phase 1).** Exact match on the normalized E.164 value. No partial, prefix, name or fuzzy matching.
- **Echo Grid ID (Phase 2, needs a decision).** It does not exist today. It would need a new unique, human-friendly, check-digit code per customer, shown in the customer's wallet. That is a customer data-contract change, so it must be defined together with CUSTOMER-AUTH-01B (data contract) rather than here, to avoid two identifier designs.

### 4.2 Lookup endpoint (proposed contract)

`POST /api/v1/loyalty/actions/lookup-customer` (a POST, so the phone never appears in a URL or access log). Permission `loyalty:serve`. Business scope comes from the session.

- Body: `{ "phone": "+15551234567" }`, validated with the existing E.164 schema.
- **Found** (an active membership **in this business**): returns `{ lookupToken, displayName, phoneMasked, membershipStatus: "active", loyaltyAccountId, actions }`.
  - `displayName` is the first name only, or "Member" if none is stored.
  - `phoneMasked` shows the last four digits.
  - `lookupToken` is a signed, short-lived (about 2 minutes) token bound to business, staff user and customer, built like the existing customer QR token.
- **Not found, not a member of this business, suspended customer, or any other miss:** one uniform response (`404 MEMBER_NOT_FOUND`), same shape and timing. The cashier is not told which case applied.
- It never creates a membership or account. Joining stays a customer-side action (the customer's own QR flow).

### 4.3 What a lookup may do

| Action                                              | Via lookup?                              | Reason                                                               |
| --------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| View member state (points, tier, available rewards) | Yes                                      | Same as the scanned-QR view                                          |
| Record a purchase                                   | Yes, flagged                             | Business-owned points; amount is cashier-entered either way; see 4.4 |
| Confirm a reward redemption                         | Only with the customer's redemption code | Value out; needs customer proof (existing two-phase design)          |
| Join loyalty, orphan settlement, manual adjustment  | No                                       | Customer consent or administrative authority required                |

### 4.4 Marking and containing lookup-identified purchases

- Phase 1 minimum: every lookup writes an audit row (`loyalty.customer_lookup`), and the purchase that follows carries the `lookupToken`.
- Recommended additive migration (own authorization): a nullable `identified_by` column on `loyalty_purchase_events` (`'qr'` or `'lookup'`), so reporting and caps do not depend on joining audit rows.
- Caps (proposed, owner to set): at most N lookup-identified purchases per cashier per day and per business per day, with a daily total amount limit; overruns are refused with a clear message and raise a fraud signal.
- Manager report (existing analytics surface): lookup-identified purchases per cashier per day.
- Transparency: the customer already receives the `points_earned` notification after a purchase. A lookup-identified purchase should say so in the notification text, so an unexpected credit is visible.

### 4.5 Abuse, privacy and rate limits

- A dedicated limiter binding for lookups (new `ratelimits` entry in both environments), keyed by staff user and business. Starting estimate: 10 per minute per cashier, 60 per hour per business. These numbers are estimates, as the existing limiters' own comments say.
- Audit every lookup. Store an **HMAC of the phone** (server-side key), not the plaintext number, in the audit metadata.
- Raise a fraud signal after repeated misses by one cashier (for example 5 misses in 10 minutes). The signal pattern already exists in the codebase.
- Return no customer data for non-members. The platform customer table is never queried without a membership join.
- The lookup is not available to roles without `loyalty:serve`. Platform and impersonation sessions follow existing rules.

### 4.6 Existing gap this design exposes (separate hardening, not part of D-C2)

`POST /accounts/:id/purchase` accepts any account id the cashier holds and does not verify that the account was reached through a proof. Today that is acceptable because a cashier cannot learn an account id without a scan. After D-C2 they could. Recommended companion hardening, as its own authorized block: require a valid, unexpired `resolve` or `lookup` token for the same business and account when recording a purchase. D-C2 can ship without it only if the caps in 4.4 and the audit are in place.

### 4.7 Owner direction (2026-11-12): one field for scanner device or phone

The owner asked that "Verify with QR token" become a single **customer search** that works with either a connected scanner device or a typed phone number, to speed up counter operations. The camera scan stays as it is. The scanner device works as a keyboard: it types the code and presses Enter.

- **One field, always visible and focused.** It replaces both the "Verify with QR token" button and the collapsed "Enter the QR token manually" section. Today a cashier must click to open a hidden section before a hardware scanner can type into it.
- **Input detection.** A long string with letters or token separators is treated as a scanned customer token and resolved exactly as today. A value made of digits (with an optional leading `+`, spaces, dashes or brackets) of phone length is treated as a phone lookup (section 4.2). Anything else shows "Scan a QR code or enter a phone number". No guessing beyond those two shapes.
- **Scanner behaviour.** Keep focus after every action and after "next customer". Submit on Enter only. Trim whitespace and control characters that some scanners add before or after the code. Never submit a partial value.
- **Same safety path.** A device-scanned token is verified exactly like a camera-scanned one: signed, short-lived, business-scoped. Nothing about token security changes.
- **Label honesty.** The control may only be labelled as a search (for example "Find customer") once phone lookup exists. Until D-C2b ships, the field must say what it does ("Scan or enter customer QR code"), the same lesson as D-C1 (a "Search customers" button that was only a token check).
- **Split for speed.** The scanner-ready field needs no API change and can ship first as a web-only block (D-C2c-0). Phone lookup follows D-C2b.

## 5. Web experience (proposed)

- Keep **Scan** as the primary action.
- Replace the QR-token-only manual entry with the single field described in 4.7: scanner device or phone number. Once phone lookup exists it may be labelled as a customer search; before that it must say "Scan or enter customer QR code". Phase 2 adds the Echo Grid ID to the same field with format detection.
- Show the result as a compact card (first name, masked phone, tier, points) with the same follow-on actions as a scanned customer, plus a small "identified by phone" badge.
- The separate "Enter the QR token manually" section goes away: pasting or typing a token into the same field still works.
- All new strings in en, fr, es and ar; native review required for fr, es and ar.
- Phone input: accept the national format and normalize with the business country, and show the normalized number before the lookup is sent. The country source is an open detail (section 9).

## 6. Data and infrastructure changes

| Change                                                                    | Needed for           | Type                                              |
| ------------------------------------------------------------------------- | -------------------- | ------------------------------------------------- |
| New rate-limit binding (both environments)                                | Phase 1              | Config, `wrangler.toml`                           |
| `loyalty_purchase_events.identified_by` (nullable text, check constraint) | Phase 1, recommended | Additive migration                                |
| `customers.public_code` (unique, checksum) and wallet display             | Phase 2              | Additive migration; define with CUSTOMER-AUTH-01B |
| Fraud-signal category for repeated lookup misses                          | Phase 1              | Code                                              |
| New permission                                                            | None proposed        | Cashiers keep `loyalty:serve`                     |

Any migration needs its own authorization, a Neon snapshot first, staging before production, and the release order already agreed.

## 7. Acceptance conditions (for the build blocks)

1. A cashier with `loyalty:serve` can look up an active member of their own business by exact phone number.
2. A non-member, suspended customer, malformed number or a member of another business all produce the identical response and timing.
3. The response contains no email, birthday, full name, full phone number, customer id or other tenant data.
4. A role without `loyalty:serve` (for example a custom role with `loyalty:view` only) is denied.
5. The lookup respects the limiter and returns a clear message when limited; repeated misses raise a fraud signal.
6. Every lookup and every lookup-identified purchase is audited. No plaintext phone appears in audit metadata or logs.
7. A lookup token is bound to business, staff user and customer, expires, and cannot be used by another user or business.
8. Redemption cannot be completed from a lookup alone.
9. Caps refuse excess lookup-identified purchases and the refusal is visible and audited.
10. Lookup never creates a membership, account or customer.
11. The web page offers only Scan, phone lookup and the token fallback, accessible and usable on a phone, in all four locales.
12. Phase 1 does not touch financial, settlement or Partner Credit paths.

## 8. Build sequence (each separately authorized)

| Block             | Content                                                                                                    | Gate                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| D-C2a             | This design                                                                                                | Owner review                                         |
| D-C2b             | API: lookup endpoint, token, limiter, audit, fraud signal, caps, optional `identified_by` migration, tests | Own authorization; migration needs the release order |
| D-C2c             | Web: lookup field and result card, 4 locales                                                               | Own authorization, after D-C2b                       |
| D-C2d             | Staging validation by the owner (cashier, manager, owner roles)                                            | Owner                                                |
| D-C2e (hardening) | Require a proof token on the purchase endpoint                                                             | Own authorization                                    |
| D-C2f (Phase 2)   | Echo Grid ID, after CUSTOMER-AUTH-01B defines the identifier                                               | Own authorization                                    |

## 9. Owner decisions needed

| ID      | Question                                                                                          | Recommendation                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D-C2-1  | Phone only first, or both phone and Echo Grid ID?                                                 | Phone first. The ID does not exist and belongs in the CUSTOMER-AUTH-01B data contract.                             |
| D-C2-2  | May a lookup alone record a purchase, or is it view-only?                                         | Allow purchases, flagged and capped, with audit and a manager report.                                              |
| D-C2-3  | Must the customer confirm (for example with an SMS code) before a lookup-identified purchase?     | Not in Phase 1. It would add SMS cost and depends on the pending Twilio decision. Revisit if fraud signals appear. |
| D-C2-4  | Daily caps: how many lookup-identified purchases per cashier and business, and what total amount? | Owner sets the numbers; the design only requires that caps exist.                                                  |
| D-C2-5  | Add the nullable `identified_by` column now (migration) or rely on audit rows?                    | Add it; reporting and caps are simpler and safer.                                                                  |
| D-C2-6  | Should the customer's `points_earned` notification say it was recorded by lookup?                 | Yes.                                                                                                               |
| D-C2-7  | Which country defaults national phone input?                                                      | The business's configured country; confirm where that setting lives.                                               |
| D-C2-8  | Separate permission (`loyalty:lookup`) so owners can switch lookup off per role?                  | Not needed now. Revisit only if owners ask for per-role control.                                                   |
| D-C2-9  | Authorize the companion hardening (proof token on the purchase endpoint) and when?                | Yes, before or together with D-C2b.                                                                                |
| D-C2-10 | Ship the scanner-ready field first (D-C2c-0, web only), before phone lookup exists?               | Yes. It removes the extra click for hardware scanners now and carries no API or data risk.                         |

## 10. Not covered

Name search, partial phone search, browsing the member list, joining a customer from the cashier side, remote enrollment (CUSTOMER-AUTH-01G, blocked on BDPN-01), and any financial, settlement or Partner Credit behavior.
