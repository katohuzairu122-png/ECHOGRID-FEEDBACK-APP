# WEB-PUSH-01: phone and desktop push notifications (design only)

**Status: DESIGN ONLY. FUTURE FEATURE. Nothing in this document is built, migrated, deployed or authorized.**
Written 2026-11-13. Every block below needs its own authorization. Financial activation remains NO-GO.

## 1. Goal

When a business replies to a customer, or a customer writes to a business, the other side's phone or computer shows a notification even when Echo Grid is closed, like WhatsApp. Tapping it opens the conversation.

Step 1 (merged separately, PR #399) already shows unread counts inside the app. This feature adds the "outside the app" part.

## 2. Current state (verified in the repository)

- PWA installable: `manifest.ts`, `public/sw.js` with install/activate/fetch handlers only.
- No push handler, no VAPID keys, no subscription storage, no subscription code anywhere.
- Notification pipeline: `NotificationService.notify` / `notifyBusinessStaff` -> queue -> `NotificationDeliveryService`. Deliverable channels today: email (Resend) and SMS (Twilio), production only. The pipeline already anticipates more channels.
- Events that matter: `message_received` (staff -> customer) and `message_reply_received` (customer -> staff, requires `messages:view`).

## 3. Proposed design

### 3.1 Data (one migration, next free number at build time)

`push_subscription`: `id`, `owner_type` (`staff_user` | `customer`), `owner_id`, `business_id` (nullable; staff only), `endpoint` (unique), `p256dh`, `auth`, `user_agent` (short), `created_at`, `last_seen_at`, `revoked_at`.

- Endpoint and keys are secrets-adjacent: never logged, never returned by any API, never included in audit metadata.
- A customer may have several devices; a staff user may have several. Revoke on sign-out of that device, on HTTP 404/410 from the push service, and on explicit "turn off".
- RLS/ownership rules follow the existing customer and staff boundaries. No cross-owner reads.

### 3.2 Keys

A VAPID key pair. The private key is a Cloudflare Worker secret set by the owner; Claude never sees or handles it. The public key is exposed to the web app as a public environment value. Rotation procedure documented in the build block; rotating invalidates existing subscriptions (users are re-prompted).

### 3.3 Sending

- New `push` channel in the existing notification system, queued like email/SMS so a failing push never blocks a message send.
- Implementation on Workers: Web Crypto only (ECDH, HKDF, AES-128-GCM, "aes128gcm" content encoding, VAPID JWT with ES256). Prefer a small, audited library only if it runs on Workers without Node APIs; otherwise implement in about 150 lines with test vectors from RFC 8291/8292.
- Payload: small JSON `{ type, conversationId, businessName, preview?, url }`. Per-conversation `tag` so repeated messages replace each other instead of stacking.
- Retry: transient errors retried by the queue; 404/410 revoke the subscription.

### 3.4 Client

- `public/sw.js`: add `push` handler (show notification) and `notificationclick` handler (focus an open tab or open the conversation URL).
- "Turn on message notifications" control (customer wallet / messages page; staff settings). Asked only on a user tap, never on page load. Shows current state and a "turn off" action.
- Re-uses the step-1 unread poller as the fallback when push is off or unsupported.

### 3.5 Rules to keep

- No push if the recipient is currently looking at that conversation (client suppresses when a visible window exists).
- Staff push only to users with `messages:view` for that business; customer push only to the recipient customer.
- Per-owner rate cap and per-conversation coalescing to avoid spam.
- Business setting and customer preference to switch off; quiet hours optional (see decisions).

## 4. Platform limits (to tell users plainly)

- Android Chrome/Edge/Firefox and desktop browsers: work in the browser or installed app.
- iPhone/iPad: push works only for the app added to the Home Screen (iOS/iPadOS 16.4 or later), and only after the user grants permission from a tap inside that installed app. Plain Safari tabs do not receive push.
- Delivery is best effort and controlled by the push service; it is not a guaranteed channel, so email/SMS and the in-app counts remain.

## 5. Owner decisions needed before building

| ID   | Question                                                                          | Recommendation                                                             |
| ---- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| WP-1 | Show message text on the lock screen, or a generic "New message from <business>"? | Generic by default (privacy); optional preview toggle later                |
| WP-2 | Which staff get pushes?                                                           | Everyone with `messages:view`, each can mute                               |
| WP-3 | Who generates and stores VAPID keys?                                              | Owner, as Cloudflare secrets; Claude never sees them                       |
| WP-4 | Quiet hours / per-business preferences in v1?                                     | Not in v1; on/off per device only                                          |
| WP-5 | Customers prompted when?                                                          | Only from a button, after their first message exchange                     |
| WP-6 | Staging first?                                                                    | Yes: staging VAPID pair, staging deploy, real phone test before production |

## 6. Proposed blocks (each separately authorized)

| Block | Content                                                                                  | Gate                                       |
| ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| WP-A  | Owner answers WP-1..WP-6                                                                 | Owner                                      |
| WP-B  | Migration for `push_subscription` + repository + subscribe/unsubscribe API + tests       | Own authorization; migration staging-first |
| WP-C  | Sender (Web Crypto) + `push` channel + queue wiring + RFC test vectors                   | Own authorization                          |
| WP-D  | Service worker handlers + enable/disable UI (en/fr/es/ar)                                | Own authorization                          |
| WP-E  | Staging VAPID keys (owner), staging deploy, test on one Android and one installed iPhone | Owner + deploy authorization               |
| WP-F  | Production rollout                                                                       | Own authorization; not before WP-E passes  |

Estimated size: WP-B/C/D are each a normal block; WP-C is the largest and most security-sensitive.

## 7. Risks

- Subscription endpoints are sensitive identifiers; storage and logging rules above are mandatory.
- Hand-rolled push crypto is easy to get subtly wrong; test vectors and a real-device check are required, not optional.
- iPhone behavior depends on the user installing the app; expectations must be set in the UI copy.
- Lock-screen previews can leak private messages (WP-1).

## 8. Out of scope

Native app store apps, rich media notifications, notification categories beyond messaging, marketing pushes (would need separate consent design).
