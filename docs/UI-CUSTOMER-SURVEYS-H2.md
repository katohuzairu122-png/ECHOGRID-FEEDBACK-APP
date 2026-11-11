# Customer Surveys H2 (web only)

Status: IMPLEMENTED, validation pending (draft PR; nothing deployed).

## Scope
Customer-facing Surveys on EXISTING endpoints only (`/surveys/me/*`). No API, DB, auth or migration change.
- `/loyalty/dashboard/surveys`: the customer's own history (`GET /surveys/me/participations`, paged 20, no total so one extra row detects a next page). Business names are resolved for display only.
- `/loyalty/dashboard/surveys/[campaignId]`: take one survey (`GET .../campaigns/:id`, then consent + `POST .../start` and `POST .../submit`).
- QR page: a "Take survey: <name>" link for each campaign the server resolved with the `TAKE_SURVEY` action (`surveyCampaigns`).
- **Surveys** is now a customer navigation destination (D2: added only because it now functions).

## Behaviour notes
- The API identifies a participation by ONE idempotency key shared by start and submit. The form holds a single key per render; using two keys returns 404 (found and fixed during browser verification).
- The API stays the authority for audience, repeat policy, open window and answer validation. Failures map to localized messages: 403 not available, 404/409 closed or already taken, 400/422 check answers, otherwise try again. A failure is never shown as an empty list.
- Question types: text, textarea, rating (min/max, default 1-5), single_choice, multi_choice, boolean, number. Only answered questions are sent. Submit stays disabled until consent is given and required questions are answered (the server re-checks).

## Known limitation (needs a backend decision)
There is no "list surveys available to me" endpoint. A customer finds surveys through a business QR code (`surveyCampaigns` on the resolve response) or a direct link; the history page shows an honest empty state that says so. A discovery list would need a new authorized endpoint.
