# CASHIER-AUTH-02E E2D: secure Cloudflare test mail receiver (2026-11-19)

Status: **DEVELOPED AND TESTED LOCALLY; NOT DEPLOYED; NOT CONNECTED TO ANY DOMAIN.** Baseline: `main` @ `7a1d11c` (E2C, PR #531, merged). Production untouched. Live acceptance stays disabled.
No domain was registered, no DNS or MX record changed, no Email Routing rule activated, no Worker deployed, no secret created, no external mailbox read, no real customer created.

## 1. Purpose and scope

E2C delivered the restricted verification-mailbox contract and a local-spool adapter, but nothing could *receive* the real confirmation email of a synthetic customer. E2D adds that receiver (a test-only Cloudflare Email Worker) and a receiver-backed adapter that plugs into the **unchanged** `RestrictedVerificationMailbox`. It adds no product behaviour: the application, its customer-auth service, the link format `/loyalty/signup/verify#c=<challengeId>.<proof>`, consent, single-use and attribution rules are not touched.

Where: `apps/mail-receiver/` (new, private, never deployed by any workflow); harness side `apps/api/scripts/acceptance/cashier-02/adapters/{cloudflare-receiver,receiver-protocol}.ts`; preflight items P16 and P17; config field `mailbox.receiverHost`.

## 2. Cloudflare documentation verified (2026-11-19, developers.cloudflare.com)

| Topic | Verified fact | Design consequence |
|---|---|---|
| Email Worker | `export default { async email(message, env, ctx) }`; `message.to` is the envelope RCPT TO, `message.from` the envelope MAIL FROM, `message.raw` a stream, `message.rawSize`, `setReject(reason)` (permanent SMTP error) | Route on `message.to` only; never the `To` header; reject with a fixed reason |
| Inbound size | 25 MiB platform limit | The receiver enforces its own 256 KiB limit (hard ceiling 1 MiB), on declared AND actually-read bytes |
| Authentication | Email Routing validates DMARC before invoking the Worker and **prepends** `Authentication-Results: mx.cloudflare.net; spf=…; dkim=…; dmarc=…`; trust only the **first** such header whose authserv-id is `mx.cloudflare.net`; later ones can be sender-supplied | `cloudflareDmarcPass()` reads the first header only and requires `dmarc=pass` |
| Platform rule | Mail must pass SPF or DKIM, or it is rejected at the platform | Defence in depth; the receiver additionally requires DMARC pass |
| Catch-all / apex | Catch-all entries (`*@domain`) support **apex domains only**; a subdomain needs literal addresses | The dedicated test domain is an apex domain with one catch-all rule to the Worker |
| Wrangler routing rules | Top-level `addresses = ["*@<domain>"]` in Wrangler config manages the routing rule on deploy (Wrangler ≥ the 2026-09-04 change) | Documented for the future approved block; **not** set in the committed `wrangler.toml` |
| DNS | Onboarding adds MX (`route1/2/3.mx.cloudflare.net`), SPF and DKIM (`cf2024-1._domainkey`) TXT records on the root domain; requires Cloudflare DNS | Needs a zone in the Cloudflare account; owner action |
| Local testing | `wrangler dev` exposes `/cdn-cgi/handler/email` to POST a raw message | Used by the end-to-end integration test |
| Workers Free plan | Workers that handle inbound email count toward standard CPU limits; on Free, complex handlers may fail with `EXCEEDED_CPU` | **Recommend Workers Paid** for the receiver's account (MIME parsing) |
| Durable Objects | SQLite-backed objects are available on Free and Paid; strongly consistent transactional storage; alarms; `transactionSync`; `deleteAll()`; SQLite storage billing active from Jan 2026 | Selected storage (section 5) |
| Postal-mime | Cloudflare's documented parser (`PostalMime.parse(message.raw)`); no dependencies; options `maxNestingDepth`, `maxHeadersSize`, `maxPartCount`, `maxRfc822NestingDepth`, `maxForwardedAddresses` | Pinned `postal-mime@4.2.0` (published 2026-10-29, older than two weeks, MIT-0) with all limits set |
| Compatibility date | Installed workerd supports up to `2026-10-26` | `compatibility_date = "2026-07-08"`, same as the API Worker |

Not assumed from earlier reports: the "Option C" feasibility. Each row above was read again today.

## 3. Architecture

```
sender (the platform's mail provider)
   │ SMTP
   ▼
Cloudflare Email Routing  (apex test domain; MX → Cloudflare; ONE catch-all rule → Worker)
   │  prepends Authentication-Results (mx.cloudflare.net)
   ▼
Receiver Worker  email()  ── reject unless: exact acc-<run>-<label>@<approved domain>; ≤ size limit;
   │                         first Authentication-Results = mx.cloudflare.net + dmarc=pass; From domain approved;
   │                         Date within 15 min; Message-ID present; exactly ONE confirmation link on an approved web host;
   │                         global ingest limit; per-recipient cap of 5
   ▼
MailboxDurableObject (one per exact recipient address; SQLite)       IngestLimiterDurableObject (one, global)
   │   stores ONLY the link; expires ≤ 15 min; alarm cleanup
   ▼
Receiver Worker  fetch()  POST /v1/claim  (HMAC-signed, fresh, one-time nonce, exact body)
   │   claim = select live + delete + return, in ONE transaction; returned messages carry the delivery-key MAC
   ▼
harness: cloudflare-receiver adapter → RestrictedVerificationMailbox (unchanged) → real customer verification
```

The Worker exposes nothing else: `GET /health` (no configuration detail), `POST /v1/claim`, everything else 404/405. There is no list, search or inbox endpoint, and the Durable Object offers the Worker only `put` and `claim` (asserted by a test).

## 4. Recipient, run and domain isolation

- One approved apex domain (`ALLOWED_RECIPIENT_DOMAIN`), owner-supplied, never invented here. The configuration refuses a domain that equals a sender domain or a link host.
- Accepted recipients: `acc-<run 4–12 [a-z0-9]>-<label 1–16 [a-z0-9]>@<domain>`, exact match, case-folded, ≤ 64 characters. Rejected (tested): real-person local parts, other domains, subdomains, look-alike suffix domains, plus-tags, dots, header-injection characters, path-traversal text.
- Isolation by construction: one Durable Object **per exact address** (`idFromName(address)`); the run id is part of the address and is re-checked on every claim; a retrieval that names a run that does not match the recipient is refused (403) before storage is touched.
- No forwarding: the fake message in the tests **throws** if the Worker calls `forward()` or `reply()`.

## 5. Temporary storage selection

| Option | Verdict | Reason |
|---|---|---|
| **SQLite-backed Durable Object per recipient (selected)** | ✔ | Methods run one at a time over strongly consistent storage; `transactionSync` is all-or-nothing; per-recipient isolation is structural; alarms give timed cleanup; `deleteAll()` returns the object to zero storage; free-plan eligible |
| KV | ✘ | Eventually consistent reads and deletes cannot guarantee single use (explicitly excluded by the directive) |
| D1 | ✘ (workable) | Transactions could prove atomic claim, but no per-recipient serialization, no timers, separate cleanup scheduler, shared database for all recipients |
| R2 | ✘ | No atomic read-and-delete |

Tables inside each recipient object: `messages`, `seen` (Message-ID hashes for replay memory, 30 min), `nonces` (120 s), `attempts` (rate window). Schema is recreated on demand, so cleanup by `deleteAll()` is safe.

## 6. Retrieval protocol

`POST /v1/claim`, body `{"runId":"…","recipient":"…"}` (exactly those two keys, ≤ 512 bytes).

Headers: `x-acc-ts` (ms epoch, within ±60 s), `x-acc-nonce` (32 hex, single use), `x-acc-sig` = HMAC-SHA256(retrieval key, `v1\nPOST\n/v1/claim\n<ts>\n<nonce>\n<sha256(body)>`). Verified with Web Crypto `verify` (constant time) **before** any parsing of the body. Order of refusals: unavailable (503, misconfiguration, no detail) → size (413) → auth/freshness/replay (401, one identical body for every failure, so replay and bad signature are indistinguishable) → shape (400) → run/recipient/domain mismatch (403) → rate limit (429, 30 per minute per recipient) → success.

Why HTTPS and not a service binding: the harness runs outside Cloudflare (a developer machine or CI), so a binding does not fit. Least privilege is provided by the dedicated retrieval key, request freshness and one-time nonces.

Response: `{"messages":[{to, runId, receivedAtMs, text, mac}]}`; `mac` is the **delivery-key** HMAC over `v1\n<to>\n<runId>\n<receivedAtMs>\n<sha256(text)>`, byte-for-byte the E2C spool envelope, so the existing `verifyMessage` verifies it (a known-answer vector asserted in both packages prevents drift).

## 7. One-time consumption (mandatory invariant)

A claim = one `transactionSync`: purge expired → rate check → record nonce → select live messages of this run → **delete them** → return. Tested on real workerd Durable Objects:

| Property | Test | Result |
|---|---|---|
| First claim succeeds, second returns nothing | store + receiver tests | PASS |
| Two (and thirty, and twelve over HTTP) simultaneous claims → exactly one winner | store + receiver tests | PASS |
| Unrelated recipient cannot claim | store test | PASS |
| Other run (same recipient) cannot claim and does not consume | store test | PASS |
| Expired message never returned; last millisecond still claimable | store test | PASS |
| Replayed nonce refused, consumes nothing | store test | PASS |
| Storage failure inside the claim rolls back: nothing returned, message and nonce intact, then claimable exactly once | fault injection | PASS |
| Restart (`state.abort`) does not restore a consumed message nor lose an unconsumed one | store test | PASS |
| Same email replayed after consumption refused (Message-ID memory) | receiver test | PASS |

Mailbox consumption is **not** challenge consumption: the application's own challenge stays single-use and independently enforced. The integration test proves both (mailbox second retrieval fails; the application completes once and refuses the replay; a wrong proof is refused even with a genuine retrieved link).

## 8. Expiration and retention

Message life: arrival time + 15 minutes; enforced logically in the purge and again in the select of every claim; physical cleanup by Durable Object alarm. Message-ID memory 30 min, nonces 120 s. When nothing remains the object calls `deleteAll()` (storage billing stops). Stored content is only the confirmation link (the proof is in it, so it lives at most 15 minutes and is deleted on retrieval); subject, body, display name, attachments and headers are discarded, never stored.

## 9. E2C integration

`cloudflare-receiver` is registered in `adapters/index.ts` as a `MessageSource`; the wrapper still enforces approval, exact synthetic recipient, run binding, freshness, the 15-minute link lifetime, https + approved web host + path + `#c=<uuid>.<64 hex>` fragment + no query, evidence minimization and sanitized errors. The adapter adds: one approved host only (`mailbox.receiverHost`, which `ACCEPTANCE_MAILBOX_RECEIVER_HOST` must repeat exactly; never production, never an application host), `redirect: 'error'`, 15 s timeout, a 128 KiB response cap, at most 5 messages, delivery-MAC verification of every message, fixed error sentences (no status body, host or key), 429 treated as "no message yet". No second message schema was introduced.

## 10. Secrets (names only; nothing generated, uploaded or committed)

| Name | Held by | Job |
|---|---|---|
| `ACCEPTANCE_RECEIVER_RETRIEVAL_KEY` | receiver Worker secret; harness environment | authenticates retrieval **requests** |
| `ACCEPTANCE_MAILBOX_DELIVERY_KEY` | receiver Worker secret; harness environment (existing E2C name) | authenticates returned **messages** |
| `ACCEPTANCE_MAILBOX_RECEIVER_HOST` | harness environment | must equal the approved `mailbox.receiverHost` |

A separate retrieval key is warranted: the delivery key proves what the receiver *received*; the retrieval key proves who may *ask*. The two must differ (enforced on both sides), each ≥ 32 characters, random, never defaults. Staging/test keys must never be reused anywhere else; the receiver refuses to run unless `RECEIVER_ENVIRONMENT = "acceptance-test"`. Rotation: generate two new values; set them as Worker secrets and in the harness environment in one window (the receiver holds no long-lived messages: everything expires in 15 minutes, so no migration is needed); revoke the old ones; run one claim as a smoke check. Keys are never in `wrangler.toml`, a bundle, a workflow, a log, a result file or this repository.

## 11. Abuse prevention (20 listed risks)

| # | Risk | Control |
|---|---|---|
| 1 | Recipient enumeration | Rejection reason is one fixed sentence; unauthenticated retrieval is one identical 401; no list/search |
| 2 | Cross-run retrieval | DO per address; run bound in address and re-checked; 403 |
| 3 | Replay of a consumed message | Message-ID memory 30 min; Date window 15 min |
| 4 | Concurrent double consumption | Serialized DO + one transaction |
| 5 | Forged delivery metadata | Envelope RCPT TO only; first `Authentication-Results` from `mx.cloudflare.net` with `dmarc=pass`; delivery MAC |
| 6 | Spoofed sender | DMARC pass first, only then From domain against an approved list (display name never consulted) |
| 7 | Malformed MIME | Safe parser with nesting/part/header limits; any failure rejects |
| 8 | Oversized attachments | Size limit on declared and read bytes; attachments discarded |
| 9 | HTML/script injection | Never rendered or executed; only a validated URL is kept |
| 10 | Path traversal | No filesystem; DO names from a validated regex |
| 11 | Header injection | Headers are read, never reflected; recipient regex excludes control characters |
| 12 | Storage exhaustion | ≤ 5 messages per recipient, ≤ 120 accepted per 10 minutes globally, 15-minute life, `deleteAll()` |
| 13 | High-volume unsolicited mail | Global ingest limiter + recipient namespace + DMARC + approved senders |
| 14 | Excessive polling | 30 claims per minute per recipient (429); the adapter treats 429 as "not yet" |
| 15 | Expired confirmation links | Receiver expiry + wrapper `LINK_LIFETIME_MS` check |
| 16 | Inconsistent timestamps | Arrival time is the receiver's clock; `Date` header must be within [-15 min, +2 min] |
| 17 | Restart during storage | Transactional writes; restart tests |
| 18 | Network failure during retrieval | A lost response after a claim means the message is consumed and unrecoverable: the harness refuses (sanitized) and the operator uses a new label; fail closed by design |
| 19 | Cross-environment credential reuse | `RECEIVER_ENVIRONMENT` guard; independent keys; separate keys per environment |
| 20 | Unauthorized Worker access | `workers_dev = false`, `preview_urls = false`; HMAC on every route that returns data; no data route without it |

## 12. Preflight (offline, no approval flag is ever set)

`P05` mailbox approved · `P06` adapter registered · `P07` credentials present **by name** (host, both keys, distinct) · `P08` recipient domain approved · **`P16` receiver host approved and not production/application (new)** · **`P17` recipient isolation: the domain is not a production, application or receiver host (new)** · `P02` production hosts excluded · `P09` provisioning approved separately · `P04` live execution approved separately · `P11` browser ready. `staging-targets.json` still has every approval `false`, `receiverHost: null`, `adapter: "none"`. The configuration guard refuses an approved `cloudflare-receiver` mailbox without a receiver host and exactly one recipient domain.

## 13. Infrastructure preparation (for a LATER, separately authorized block)

Prerequisites the owner must provide or approve: (1) a dedicated apex test domain controlled by INFINICUS LLC, in a Cloudflare zone (not the production customer-email domain); (2) the receiver host name; (3) the approved sender domain(s) the platform's mail provider sends from; (4) the approved staging web host(s); (5) a Cloudflare account/plan decision (**Workers Paid recommended**); (6) permission to create two secrets.

Receiver identity: Worker `echo-grid-acceptance-mail-receiver`; bindings `MAILBOX`, `INGEST_LIMITER` (Durable Objects, migration `v1` SQLite); variables `RECEIVER_ENVIRONMENT`, `ALLOWED_RECIPIENT_DOMAIN`, `ALLOWED_SENDER_DOMAINS`, `CONFIRMATION_LINK_HOSTS`; secrets as section 10. Account permissions for the deployer: Workers Scripts edit, Durable Objects, Email Routing edit and DNS edit on the one test zone (least privilege API token scoped to that zone), Workers Secrets.

Estimated cost (current docs): Email Routing inbound **unlimited, no charge**; Workers Paid minimum **US$5/month** (recommended; includes 10 M requests and 30 M CPU-ms); Durable Object SQLite: Free 5 M rows read/day, 100 k rows written/day, 5 GB; Paid 25 B reads, 50 M writes, 5 GB-month included then US$0.20/GB-month. A run of a few dozen synthetic customers is a few hundred rows: **effectively US$0 beyond the plan**. Domain registration cost depends on the TLD and registrar (typically about US$10–15/year for common TLDs at cost); not verified here.

Deployment procedure (future): owner approves domain and hosts → create zone/domain → set vars in a reviewed change → `wrangler deploy` of this Worker only (not any app) → set the two secrets → `addresses = ["*@<domain>"]` (or one dashboard catch-all rule → Worker) → verify DNS (MX, SPF, DKIM) → `GET /health` → send ONE mail from the approved sender to `acc-<run>-smoke@<domain>`, claim it, confirm the second claim is empty → record the approvals in `staging-targets.json` through a reviewed change.
Health check: `GET /health` = `{"ok":true}` only when configuration is complete and safe; 503 otherwise.
Recovery: the receiver holds nothing durable beyond 15 minutes; redeploy or roll back freely. If a claim response is lost, use a new label.
Cleanup: nothing to clean (alarms + `deleteAll()`); to purge immediately, delete the Durable Object namespace via a new migration.
Decommissioning: disable the catch-all rule, remove MX/SPF/DKIM records of the test zone, delete the Worker and its secrets, delete the namespace, revoke the API token, record it.

## 14. Limitations and honest gaps

1. **Not live-verified.** Delivery through real Cloudflare Email Routing, real DMARC results, and the platform's real mail provider as sender are NOT exercised: the local tests inject the `Authentication-Results` header Cloudflare is documented to prepend. The sender's `From` domain, the exact header format and that the provider's mail passes DMARC for the approved sender domain are first confirmed by the one smoke mail in the future block.
2. The receiver enforces 15-minute expiry on arrival time; a mail delivered long after it was sent is rejected by the `Date` window, which relies on the sender's Date header being honest. Combined with Message-ID memory this bounds replays; the application's own challenge remains the final authority.
3. SMS codes are not carried by this receiver (email only).
4. A lost claim response consumes the message (by design, fail closed).
5. Hosted CI exercises the receiver's unit, Workers-runtime and dry-run build, and the integration test (a local `wrangler dev` child process). No CI job calls Cloudflare.

## 15. Not authorized and not done

Domain registration; DNS/MX changes; Email Routing activation; Worker deployment; secret creation/rotation; external mailbox access; real customer creation; live staging acceptance; production changes; merging; E3/E4; any approval flag change (`approved`, `approvedBy`, `approvedAt`, `authorizedBy`, references).
