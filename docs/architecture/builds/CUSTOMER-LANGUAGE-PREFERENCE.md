# Customer language preference and shared language selector

Status: IMPLEMENTED — VALIDATION PENDING (draft PR; nothing migrated or deployed).

## Behaviour
- One shared `LanguageSelector` (components/language-selector.tsx) on customer and public surfaces:
  customer shell (sidebar and More sheet), customer login, QR feedback and QR loyalty pages.
- Staff surfaces are unchanged: staff keep their business default language (no selector).
- Precedence for customer/public surfaces: saved customer preference (signed in) > `ff_locale` cookie >
  business default language > English. Any lookup failure degrades to the next source and never breaks a page.
- Choosing a language always sets the cookie; a signed-in customer's choice is also saved via
  `PUT /api/v1/customer-language` (own row only, customerId from the verified JWT). The save is best effort.

## Backend
- Migration `0067_customer_preferred_locale`: nullable `customers.preferred_locale`, CHECK in (en, es, fr, ar). No backfill.
- `GET/PUT /api/v1/customer-language` (customer JWT, public rate limiter).
- Gate 2 pins re-pinned from 67 to 68 migrations (scripts, workflows, release tests). CI job `name:` lines were left
  unchanged so required-check names do not move.

## Operational note
Production/staging databases are not migrated by this PR. Until migration 0067 and the API are deployed, the web
selector works through the cookie only (the saved-preference read/write fails quietly). Staging currently needs
23 pending migrations (was 22).
