# Public landing reference implementation review

Baseline: main `851a94e68c635fad16624485a586d5241707f309` (merged #134/#135).
Scope: public presentation only; draft PR, no deployment or financial activation.

## Design-to-component mapping

| Reference | Integrated component / treatment |
| --- | --- |
| Image 1: navy café hero and mint headline | Root page hero, local optimized café WebP, scoped CSS module, existing Logo |
| Image 1: phone and branch QR presentation | PhonePreview and QrPreview, real HTML/SVG with explicit illustrative labels |
| Image 1: six platform features | Six responsive translated feature cards and existing-style SVG icons |
| Images 1 and 2: business dashboard | DashboardPreview with static example figures and chart, never customer/API data |
| Image 2: four onboarding steps | Semantic ordered list with four translated steps |
| Image 2: customer/mobile benefits | Second phone preview, global customer identity and separate per-business loyalty balances |
| Image 2: six industries | Six translated use cases with generated decorative photography sprite |
| Reference navigation: Pricing | Approved USD monthly display prices, custom Enterprise; no automatic checkout |
| Image 2: final registration strip | Café backdrop, registration link and complete existing legal footer |

## Architecture and honest copy

- Preserve existing hasSession -> /dashboard behavior. Customer cookie is separate and does not authenticate staff.
- Registration -> /signup; staff sign-in -> /login; customer entry -> /loyalty/login; resources/Enterprise -> /support. Other navigation uses real section anchors.
- Public marketing images and existing public legal pages use an exact middleware allowlist. No /landing prefix or protected-route bypass. Tests cover negative lookalike and nested paths.
- Preview figures are noninteractive illustrations. No balance, reward, permission or economic claim is taken from them.
- Illustrative QR opens the public homepage only; it is not a signed branch token or new QR identity.
- Loyalty points are business-specific. Remove the reference's implication of a shared transferable balance.
- Do not advertise discovery, universal reward earning, Partner Credit earning/redemption, or cross-business settlement as generally available.
- Example analytics and mobile balances are labeled; no sensitive user information is embedded.
- PC-ECON/1, Split 06 consent/acceptance, and Split 07/08 migrations 0041/0042/0044 remain untouched.
- Existing feature/CTA translations remain; marketing messages added in en/es/fr/ar.
- No new dependencies, config changes, migration, API endpoint, database operations or Stripe calls.

## Pricing

Free $0, Starter $9, Growth $29, Business $59 per month in USD.
Enterprise is custom, not the catalog's zero-price placeholder.
Catalog-parity test reads approved API catalog source without importing API runtime/types into the web application.

## Visual differences from the references

- Preserve the repository's actual Echo Grid mark rather than replacing it with the references' alternate circular logo.
- Code-built example phone replaces the photographed hand/phone. This avoids embedding an unsupported UI or misleading shared balance in a raster asset.
- Code-built dashboard uses feedback/branch/rating examples rather than claiming real performance or issued credit statistics.
- Customer discovery/exclusive-offer promises are replaced with supported account, feedback and business-specific reward descriptions.
- Add explicit illustrative labels, catalog-verified pricing and legal links; these add vertical space beyond the supplied crops.
- Decorative photography is generated, not a claim about real clients or locations.

## Asset provenance

Built-in image generation used for two decorative photographs; no UI/logo screenshot was generated.
Final app assets:
- apps/web/public/landing/cafe-hero.webp
- apps/web/public/landing/industries.webp

Hero prompt:
> Use case: photorealistic-natural. Asset type: decorative background photograph for ECHO GRID landing-page hero. Wide landscape photograph of a welcoming modern cafe with warm amber pendant lights, blurred coffee bar and leafy plant, polished walnut tabletop in foreground. The right half has softly blurred cafe detail and warm light; the left half is deep dark navy with abundant quiet negative space for a real HTML headline. Premium natural photography, shallow depth of field, realistic materials, emerald hints, no people, no phones, no screens, no QR codes, absolutely no letters, text, logos or watermark. Do not draw any user interface. Main UI will be overlaid as real responsive code.

Industry sprite prompt:
> Use case: photorealistic-natural. Asset type: a single decorative industry photography sprite for six website cards. Make a wide rectangular image arranged as exactly six equally sized photographic panels in a single horizontal row, edge to edge, no gutters, each panel showing a different industry. Left to right: 1 warm cafe table with white coffee cup, 2 tasteful clothing boutique with garments, 3 fitness studio with dumbbells, 4 elegant hotel bedroom, 5 refined salon chairs and mirrors, 6 medical clinic with a stethoscope on a clean desk. All six panels composed with the relevant subject centered. Cohesive warm natural high-end photography. No people, no words, no logos, no letters, no watermark. Output landscape, six equal widths in one row. These are generic illustrative scenes, no real customer information.

Both source PNGs were visually inspected and converted to compact WebP files for application use. The reference screenshots themselves are not embedded as the landing page.

## Verification

Actual local development-browser evidence (test-browser CSP bypass only; product headers unchanged) at 360/768/1440px, navigation, route/auth checks and WCAG axe results will be recorded in the PR completion comment. CI is required on the final PR SHA. Draft stays unmerged for visual/product/security review.

Local production builds were attempted under Node 24 and Node 22 but failed with Windows EPERM while creating generated .next route-type directories. Production-build verification must therefore be established by the PR CI. No config/security-header workaround is shipped.
