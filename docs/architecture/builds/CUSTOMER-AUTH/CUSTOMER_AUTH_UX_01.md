# CUSTOMER-AUTH-UX-01 — customer account experience

**Status: development implementation; blocked from merge readiness.** No feature flag, deployment, shared database, or live identity was changed.

## Repository baseline

Main was `d83a08a741ab9e3b1ee0ff18b82870d03c37e060` (including PR #544). The current architecture contains a feature-gated email/password registration and login path, rotating customer sessions, an HttpOnly-cookie web bridge, profile phone attachment, and a separate legacy phone-OTP token path. `CUSTOMER_EMAIL_AUTH_ENABLED` remains off by default and requires the existing secrets, session settings, trusted attribution, delivery and rate-limit bindings.

The OTP-first experience came from the public `/loyalty/login` page rendering the phone OTP form unconditionally. Email/password existed at `/loyalty/login/email` and was subordinate to the feature gate. `/signup` already offered the loyalty-customer choice and the `/loyalty/join` business directory, but the customer route led into OTP-first login.

## Implemented in this branch

- The customer registration page immediately collects name, email, password and confirmation. It checks the configured password minimum and confirms the passwords locally. Before proof, the server receives only email and the validated internal `next` destination; no password enters the URL, logs, email or persistent browser storage.
- Email registration continues to use the existing generic 202 response and one-time, expiring, digest-only proof. After the proof, the existing registration transaction creates a customer with the entered name, a verified email credential and an optional unverified phone claim. Existing credentials are not linked by matching text.
- After proof, the customer re-enters name/password/optional phone to complete creation. The current challenge schema does not retain registration data; preserving the password across the verification wait requires a separately reviewed digest-only pending-registration schema change. This re-entry is a known onboarding gap in this branch.
- When the existing email feature flag is enabled, `/loyalty/login` opens email/password sign-in. `?method=phone` still offers the legacy OTP flow; with the flag off, OTP behavior is unchanged. Customer `next` destinations remain constrained to same-site loyalty paths.
- Added a customer-owned profile endpoint and Settings page for name, email/verification state, masked phone/verification state, and phone verification entry. Added current-password reauthentication for password changes and sign-out-everywhere for rotating sessions. These use the existing session and phone-attachment services.
- Added English, French, Spanish and Arabic Settings strings. Phone verification remains separate from ordinary password login; verified-phone change remains unsupported by the existing policy.

## Merge blockers and activation boundary

1. Existing phone-only customers still authenticate through the legacy OTP route and receive legacy tokens. The secure email-link service requires a live, fresh-step-up rotating OTP session, but the existing OTP BFF does not establish that session. This branch does not yet implement a safe legacy-account upgrade; no existing customer identity should be treated as upgradeable until this route boundary is reconciled.
2. Email confirmation currently requires the customer to re-enter their setup values. A short-lived, server-side pending registration carrying only a password hash and name (never plaintext) is a likely remedy, but requires a new schema migration. Main's latest committed migration is 0086; no migration was allocated in this branch.
3. Disposable PostgreSQL was unavailable locally. The targeted registration integration suite was therefore skipped (3 tests). Real Chromium acceptance was blocked by the execution environment: local Chromium could not create its browser socket, and the separate browser surface could not reach the local Next.js server.
4. Exact-head hosted CI and CI-hosted Chromium acceptance have not run for this branch.

Do not merge or activate this work until the legacy upgrade, registration re-entry decision, disposable PostgreSQL coverage, browser acceptance, and exact-head hosted checks are resolved. No existing customer, membership, QR, consent, rewards, or transaction data was modified.
