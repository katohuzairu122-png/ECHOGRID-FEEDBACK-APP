# Block 2G — Billing and Commercial Readiness

Block 2G makes the adopted commercial policy and billing lifecycle an enforced release gate.

## Commands

```bash
pnpm block17:preflight
pnpm block17:audit
pnpm block17:verify:static
BLOCK17_API_URL=https://api.example.com pnpm block17:verify
pnpm block17:evidence
```

The static gate checks the plan catalog, 14-day trial, hosted Checkout and Portal, redirect allow-listing, signed webhook lifecycle, payment-failure and cancellation states, and billing permissions. It then runs the focused API billing suite, including Stripe-compatible HMAC signatures and stale-event rejection.

After deployment, the runtime gate verifies that production billing routes reject anonymous access and that the public Stripe webhook rejects unsigned payloads with `MISSING_SIGNATURE`. It does not create a charge or expose a Stripe secret in CI. The combined evidence is uploaded as `block-2g-commercial-evidence`.
