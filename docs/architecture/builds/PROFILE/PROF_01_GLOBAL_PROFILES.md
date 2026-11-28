# PROF-01: global customer profile and business appearance (API foundation, 2026-11-27)

Status: IMPLEMENTED and locally verified; migration 0109 prepared and **not applied to any shared database**; no web screens yet (PROF-02/03).

## Owner rulings (2026-11-27)
1. First block: avatars, display name and bio. **No uploads** and no new infrastructure (the API has no file storage; no R2 bucket is bound).
2. Visibility: a customer profile is **private to the customer**. A business may see only the **display name and avatar** of its own members (PROF-04; not exposed by this block).
3. Business appearance: a **logo preset and brand colour** shown inside the platform. Real logo upload waits for a later block and for an Owner amendment of the BDPN no-media ruling (S9-D8). The public BDPN directory profile is untouched.

## What this block adds
- Migration `0109_prof_global_profiles`: `customers.display_name`, `bio`, `avatar_key` (all nullable, check-constrained) and the lazy table `business_appearance` (`business_id` primary key, `logo_key`, `brand_color_key`). Additive; nothing backfilled; rollback `rollback/0109_rollback.sql` refuses once any profile or appearance data exists.
- Shared catalogue and validation (`packages/shared-types/src/profile.ts`): 12 customer avatars, 12 business logo presets, 8 brand colours, display name rules (letters, marks, digits, spaces and `. ' - _`; no links, addresses or symbols; 1 to 60), bio up to 280 characters, closed key lists, strict bodies.
- `GET/PUT /api/v1/customer-profile`: the signed-in customer's own profile; the id comes from the verified session; the sign-in handle is returned **masked** only (`a***@example.com`).
- `GET/PUT /api/v1/business-appearance`: any signed-in member reads; changing needs business-wide access and `business:manage_settings`, audited as `business.appearance_updated`.

## Security notes
Unknown or retired keys are never returned or stored; a stored key outside the catalogue reads as "none". No free text is shown to other customers. Display names cannot carry links or addresses. Moderation of display names is not built: names are visible only to the customer and to businesses they joined.

## Remaining blocks
PROF-02 customer profile screen with avatar picker and a "signed in as" identity chip in the customer shell. PROF-03 business appearance screen and chip. PROF-04 business sees member name and avatar; customers see the business logo in the wallet and on the join page (adds the two keys to the public business read). PROF-05 photo and logo upload (needs storage, size and type limits, moderation, the BDPN amendment, and deployment authorization).

## PROF-02 (customer screen, 2026-11-27)
Web only, on top of PROF-01: `/loyalty/dashboard/profile` ("My profile": avatar picker with 12 built-in avatars or initials, display name, bio, privacy note), a "Signed in as" display in the customer header (avatar, name, masked login; falls back to the plain "Customer" label when the profile cannot be read, so the header never breaks), and a "My profile" navigation entry. Four languages. The page shows "Profile is not available right now" until migration 0109 is applied and the API serves `/customer-profile`; nothing else on the customer area depends on it. Account details and security stay under Settings (that existing screen is unchanged).
