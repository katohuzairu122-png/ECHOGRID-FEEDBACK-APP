# CASHIER-AUTH-02E E2C: isolated verification mailbox integration (2026-11-19)

Status: **provider-neutral foundation implemented and tested; NO real mailbox connected; live acceptance NOT RUN and BLOCKED at the provider decision gate.** Baseline: `main` @ `fd0afec` (PR #530 merged). No approval flag was changed; no external service was contacted.

## 1. Reconciliation

| Area | State at the start |
|---|---|
| PR #530 | **Merged** (not assumed): the E2 readiness work, incl. the real-link-format fix, is on `main` |
| Link format | `<web>/loyalty/signup/verify#c=<challengeId>.<proof>` (fragment, no query), 15 minute lifetime (`+ 900_000` in `customer-email-auth.service.ts`) |
| Existing mailbox architecture | `RestrictedVerificationMailbox` (recipient, freshness, link validation in the wrapper for every adapter), `local-spool` adapter (one file per recipient, symlink/size/path checks), evidence records, preflight P01 to P15 |
| Approved provider recorded in the repository | **None.** No approved test inbox, domain or provider for reading mail; Resend is outbound delivery only |
| Staging | Workers last deployed from `fe9c5e8` (Cloudflare metadata, read only); unchanged |
| Gaps found in the existing local spool | (a) a spool file was **unauthenticated**: anyone able to write the directory could place a message (a link on the approved host but for an attacker-chosen challenge); (b) the directory permissions were not checked; (c) a message was not bound to a run beyond its recipient string; (d) an expired link was not refused by age; (e) a hanging or failing source was not bounded or sanitised; (f) the used message (it holds a one-time proof) stayed on disk |

## 2. Architecture options evaluated

| | A. Dedicated mailbox, scoped inbox access | B. Provider-supported scoped test-inbox API | C. Authenticated delivery boundary into the existing spool contract |
|---|---|---|---|
| Isolation | By mailbox: needs a dedicated mailbox and a credential that can read only it | By the provider's per-inbox scoping | By construction: only an exact recipient is ever returned, and each message is signed |
| Fit with the existing code | New protocol (IMAP or similar) and credentials | New vendor and SDK; **no vendor is approved** | **Reuses the spool format, wrapper and evidence; adds only the boundary** |
| Least privilege | Depends on the mail host | Depends on the vendor | Full: the harness never holds a provider account credential, only the delivery key |
| Owner actions | Provision mailbox, domain, secret | Choose, buy and configure a vendor | Provision a **test-only receiving domain** and a small receiver (below) |
| Risk | Credential reaches a mailbox | New third party sees confirmation messages | A receiver that is wrong or unauthenticated could inject messages: mitigated by the signed envelope |

**Recommendation: Option C**, in the pull form below, because it needs no new vendor and keeps all real restrictions in code already tested. This is a recommendation, not a decision.

### What the Cloudflare documentation says (retrieved read-only today; confirm before building)
- Email Routing is a zone feature; a **catch-all rule is available for the apex domain only**, and routing for a subdomain needs a literal rule per address. The run-bound address `acc-<run>-<label>@<domain>` is unique per customer, so a **dedicated apex test domain with a catch-all rule** is the workable shape; a subdomain of the product domain is not.
- A routing rule can send mail to a **Worker with an `email()` handler**; inbound mail is checked for SPF, DKIM and DMARC at receipt, and the Worker can reject.
- I did **not** find per-namespace scoping for Workers KV API tokens in the pages retrieved; do not assume that a token can be limited to one KV namespace. So the design below does not depend on it.
- Resend's account-wide sent-message list (earlier staging runs used it through a tool) is not a per-recipient reader: locating one recipient's message means reading unrelated messages. Not used.

### Proposed boundary (BLOCKED on owner decision; nothing built or deployed)
1. **A dedicated apex test domain** (owner registers it; no customer ever uses it) with Email Routing and a catch-all rule sending to
2. **a small, test-only receiver Worker** (owner approves its deployment) that, for each message, checks the sender and authentication result, accepts only `acc-<run>-<label>@<domain>`, extracts and stores **only the confirmation message text** with a short expiry in storage private to that Worker, and
3. **serves one message at a time to the harness over HTTPS**, on request signed with the delivery key, for one exact recipient, returning the message in the signed envelope that `local-spool` already verifies (HMAC over recipient, run, arrival time, text). The harness adapter would pin that one host (added to the approved configuration and the host guard), refuse redirects, and be bounded by the existing timeout.
No credential for the Cloudflare account, the zone or any mail provider reaches the harness. Variable names only: `ACCEPTANCE_MAILBOX_DELIVERY_KEY` (already required) plus the receiver's base host, which would be part of the approved configuration, not an environment override.
Cost: Email Routing and a Worker are on the existing plans (to be confirmed), plus the domain registration. Retention: the receiver deletes on first read or after 15 minutes. Cleanup: nothing to clean in the product environment.
Owner actions: choose the approach; register the test domain; approve the receiver Worker and its deployment; supply the delivery key (the owner generates it and enters it as a secret in both places); approve `mailbox.adapter`, the receiver host and `allowedRecipientDomains` in `staging-targets.json`.

## 3. What was implemented (provider-neutral, local)

- **Authenticated spool envelope** (`adapters/spool-envelope.ts`): HMAC-SHA256 over recipient, run, arrival time and text, with the delivery key from `ACCEPTANCE_MAILBOX_DELIVERY_KEY` (at least 32 characters, never printed). A message that fails it is **refused, not ignored**.
- **Delivery-boundary writer** (`adapters/local-spool-writer.ts`): the only way a message gets into the spool: synthetic recipients only, signed, atomic (temporary file then rename), mode 0600, at most five messages and 64 KiB per recipient, refuses a symlink or directory in the way.
- **`local-spool` hardened**: private directory required (no group or other access), run-bound messages, symlink and path checks kept, `consume` removes the used file.
- **Wrapper additions (all adapters)**: a message bound to another run is refused; an **expired confirmation link** (older than 15 minutes) is refused; a source that hangs or throws is a bounded, sanitised refusal (`The mailbox did not answer in time.` / `The mailbox could not be read.`); cleanup is attempted after use and recorded in the evidence (`done`, `failed`, `not-applicable`).
- **Preflight P07** now covers the delivery key and the private directory (names only). Live gates are unchanged: nothing sets an approval, and environment variables or flags cannot authorise a run (tested).

## 4. Security controls and tests

| Control | Enforced | Test |
|---|---|---|
| S1 recipient isolation | wrapper: exact `acc-<run>-<label>@<approved domain>`; foreign-recipient and foreign-run messages refused | PASS (mock-backed) |
| S2 environment isolation | host guard; no network in the mailbox code (static test) | PASS |
| S3 secret protection | errors and evidence carry no key, link, proof or address | PASS |
| S4 message authenticity | signed envelope; unsigned, wrong-key, swapped-recipient and tampered messages refused | PASS |
| S5 freshness | since-window, link lifetime, future-skew, duplicates and replay | PASS |
| S6 safe temporary storage | private directory, 0600 files, symlink/traversal/oversize refusal, atomic write, cleanup | PASS |
| S7 evidence minimisation | recipient hash, adapter, kind, age, cleanup only | PASS |

All of these are **mock-backed local tests** against the spool and a fixture delivery boundary. They are not a real mailbox integration and not live acceptance.

## 5. Status

| Item | Status |
|---|---|
| Provider-neutral integration, isolation, authenticity, cleanup, link format, redaction | PASS (local) |
| Offline preflight accuracy | PASS |
| Real mailbox source connected and verified | **BLOCKED** (provider decision) |
| Real customer sign-up and confirmation through a mailbox | **NOT RUN** |
| Live staging acceptance | **NOT RUN** (disabled) |
