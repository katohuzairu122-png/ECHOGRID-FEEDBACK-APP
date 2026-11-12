# BDPN-01 — Interim Content Policy for Published Business Profiles (DRAFT)

**Status: DRAFT FOR OWNER REVIEW. This is not legal advice and is not in force.** It was drafted by the author at the
owner's request (decision D-16) to unblock the moderation design. The owner, and counsel if the owner chooses, must
review, edit and approve it before any moderator applies it. Nothing here is implemented.

Purpose: give moderators a clear, consistent basis for approving or rejecting a business's public profile, and give
businesses a clear reason when a profile is rejected.

## 1. What a profile may contain

Only what the business is entitled to say about itself, in plain text: display name, short summary, description, one
category (already assigned), a location or service-area description, and one website. No images in v1.

## 2. Reasons to reject or suspend (proposed reason codes)

| Code                       | Meaning                                                                         | Typical examples                                                               |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `MISLEADING_CLAIM`         | A statement that is false, unverifiable or likely to mislead customers          | Invented ratings, awards, "#1", certifications, savings or results             |
| `IMPERSONATION`            | Pretends to be another person, business or Echo Grid                            | Another company's name or brand, "official Echo Grid partner" without approval |
| `PROHIBITED_BUSINESS`      | A product or service Echo Grid does not allow                                   | **To be listed by the owner and counsel** (the author does not set this list)  |
| `PERSONAL_DATA`            | Exposes private personal information                                            | Home address of an individual, a personal phone, an ID number, customer names  |
| `CONTACT_ABUSE`            | Contact details used to collect data or push customers off-platform deceptively | A link that is not the business's own site; tracking or redirect links         |
| `OFFERS_AND_PRICING`       | Offers, discounts, prices or opening status not verified by the platform        | "50% off today", "open now" (not supported in v1)                              |
| `HARMFUL_OR_UNLAWFUL`      | Hateful, violent, sexual, harassing, fraudulent or unlawful content             |                                                                                |
| `OFF_TOPIC_OR_LOW_QUALITY` | Does not describe a real business, is placeholder text or spam                  | "test", repeated characters, keyword stuffing                                  |
| `INCOMPLETE`               | Required fields missing or unusable                                             | No location or service area, empty description                                 |
| `LANGUAGE_MISMATCH`        | Text is not in the language it is labeled as                                    | Arabic text submitted as the English translation                               |
| `OTHER`                    | A reason not covered above; the moderator writes a short, neutral explanation   |                                                                                |

## 3. Rules for moderators

1. Decide only on what was submitted and on the platform's own records of the business. Do not contact customers.
2. Give **one clear reason code** and, where useful, a short neutral note the business can act on.
3. Approve exactly the revision reviewed (the system ties approval to its content digest).
4. A moderator may not approve their own business's profile.
5. Suspension is for policy or safety, requires a reason code and an internal note, and is reversible only by a platform
   administrator.
6. A rejection is final for that revision. The business corrects the issue and submits a new revision (decision D-15).
7. Keep an audit record of every decision.

## 4. Things this policy does not do

It does not decide which businesses are prohibited, does not set response-time promises, does not cover advertising,
promotions or offers (none are published in v1), and does not replace legal review of terms, privacy notices or
jurisdiction-specific rules.

## 5. Open for the owner

- The list behind `PROHIBITED_BUSINESS`.
- Whether counsel reviews this draft before use.
- Whether reason codes are shown to businesses verbatim or in friendlier wording (translated into `en, fr, es, ar`).
