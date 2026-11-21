# CUSTOMER-AUTH-UX-02 — Single-pass customer registration and legacy-phone account upgrade

Date: 2026-11-21. Development-only draft PR #550. No staging or production activation or shared database change.

## Baseline

Main at branch creation: `c0be450e2d6087d751b6c6e63d8690fd412aa8c4`, following merged PR #546.
PR #546 implemented the signup form, email/password login behind `CUSTOMER_EMAIL_AUTH_ENABLED=true`, rotating sessions, Settings, and phone verification entry, but left repetition of signup credentials and secure upgrading of phone-only customer accounts unresolved.

## New registration behavior

1. Web signup submits name, canonical email and password ONCE to the trusted Web Worker Server Action.
2. The Web Worker forwards them to the Hono email-auth route with signed client attribution, rate limits, body limits and existing password policy.
3. On an accepted signup request, the API derives the PBKDF2 password hash before acquiring any database lock; it AES-GCM encrypts the normalized email/name/hash with a domain-separated key derived from the existing dedicated HMAC secret.
4. The sealed payload is stored on the `email_registration` challenge row (`registration_sealed_data`), bound through AES-GCM additional authenticated data to the email subject digest and one-time proof digest. No plaintext password, email, display name or password hash is persisted in that column.
5. The email link includes only the challenge identifier and proof in the URL fragment. The browser removes the fragment from address history and submits the proof without asking the customer to re-enter name/email/password.
6. The existing atomic proof consumption creates the customer and credential; consumption clears the ciphertext. The API establishes a revocable rotating password session and returns credentials to the trusted Web Worker only, which stores them in the existing secure HttpOnly cookies.
7. Historical unsealed challenges are still accepted by the underlying service with their original completion contract; full browser compatibility of historical in-flight links has not been accepted.

### Retention limitation

Expired abandoned ciphertext is not usable after challenge expiration. Requests for the same email opportunistically clear expired ciphertext. **A global retention/cleanup policy and its authorization remain open**; a production retention claim is not made. Do not enable this workflow in any live environment without its separate privacy/security review.

## Migration 0087

Additive, nullable `customer_auth_challenges.registration_sealed_data` with CHECK restricting it to ownerless email registration challenges and 4096 characters. Journal/snapshot updated. The existing runtime already has INSERT/SELECT/UPDATE on this table. No new privileged function, role, new table, grant, ledger mutation or migration run is introduced.

No shared database (staging, production, Neon or recovery branch) was touched.

## Legacy phone-only customer upgrading

Existing phone-OTP login previously minted only a nonrotating 90-day token. The pre-existing `CustomerEmailLinkService` *correctly refuses* such a token: email linking needs the same customer's live, freshly step-up-verified rotating OTP session.

The new feature-gated, attribution-protected `/customer-auth/email/legacy/otp-login` validates the actual phone code through Twilio Verify in production or the existing one-time database OTP service in test/development. It then resolves the **verified phone owner** through the established `CustomerRepository.createIfAbsent` and establishes a rotating OTP session. Accounts that already have verified email cannot use OTP after the existing retirement rule.

The customer Settings upgrade prototype is designed to use that rotating session to request and complete the pre-existing independent email-link challenge through `/customer-auth/email/link/request` and `/customer-auth/email/link/complete`. The pre-existing service checks customer ID, session ID, fresh OTP step-up, verified phone ownership, proof expiry and one-time usage, email uniqueness and credential conflicts. Linking occurs transactionally with session revocation and legacy-token cutoff; customer ID, memberships, rewards, loyalty history and Community history are never moved to a new customer.

No new automatic account merge, password reset, altered points rule or weaker phone-verification gate is introduced.

### Isolated legacy-upgrade composition — IMPLEMENTED, OFF BY DEFAULT

The API now mounts `customer-email-link.composition.ts` as a separate Hono
composition. It is the only runtime composition that constructs the existing
link service. The existing email-auth composition does not import or reach it.
The routes return generic 404 unless **both**
`CUSTOMER_EMAIL_AUTH_ENABLED === 'true'` and
`CUSTOMER_LEGACY_UPGRADE_ENABLED === 'true'`. The latter is typed but is not
configured or activated in any environment. The static compatibility test pins
this separation and the flag checks.

The OTP-to-rotating bridge verifies the existing database OTP or Twilio Verify
proof, resolves the proven phone owner, and establishes the revocable OTP
session without minting a legacy bearer. Settings then uses the isolated link
composition and existing owner/session/step-up/proof checks. Successful linking
retains the same customer id, verifies email ownership, revokes prior sessions,
and advances the legacy-token cutoff. No identity merge is performed.

**Code for the legacy upgrade is implemented but inactive.** Its feature flag
must remain off until the rate-limit budgets in 01D-5 are approved, the target
environment's migration/provider readiness is verified, and full browser
acceptance is reviewed. The explicit user authorization in this block does not
authorize production or staging configuration changes.

### Identity and UX caveats

- A customer who already has a password hash but no verified login email must supply that existing password; the link service does not replace it merely because the phone is verified.
- The link's proof expires after 15 minutes, but the fresh OTP step-up is valid only 10 minutes; users must complete within the shorter authorization window.
- Login/upgrade routes are available only when the customer email-auth feature and all existing security bindings are configured. Production flag and provider readiness have not been inspected or modified.

## Browser and test acceptance

New unit tests cover AES-GCM roundtrip/tampering, signup proof-only actions, server-side link identity boundaries, OTP-to-rotating bridge and non-effects on failure. The pre-existing customer email-auth Playwright specification has been adjusted to request credentials once and consume a proof-only confirmation.

**Do not claim full E2E acceptance until an exact-head hosted browser test actually exercises registration, confirmation, password re-login, QR continuity, Settings phone verification, legacy upgrade and cross-customer denial.** Browser specs can be opt-in and skip without a synthetic email proof mailbox; skipped tests are NOT passes.

## Security boundaries preserved

- No activation of dormant email auth, feature flags, migrations, Cloudflare resources or secrets.
- Customer credential and ID ownership is never inferred from an unverified phone/email claim.
- Existing short-lived proofs, session rotation, rate limits, signed attribution, tenant and loyalty authorization remain mandatory.
- N14-READ-01 REJECTED: verified phone still required for Community Feed viewing and Community joining.
- P3, cashier, billing, business publishing, R8-G and D2 workstreams are not modified.

## Release and rollback

Do not merge before exact-head CI, migration-security acceptance, pending-registration retention review and customer-auth Chromium evidence. The legacy-upgrade code remains gated until 01D-5 budgets and target-environment prerequisites are approved and verified. The development branch may be abandoned without operational effect. Applying 0087 to a shared environment or enabling either feature flag needs new explicit authorization. No automatic advancement.
