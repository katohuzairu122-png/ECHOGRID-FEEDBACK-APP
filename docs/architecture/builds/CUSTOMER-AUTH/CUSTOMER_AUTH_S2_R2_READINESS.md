# Customer-auth S2-R2 development readiness

The customer-email registration and login handlers remain unmounted. The API router still uses the legacy customer middleware composition by default. The Web app calls its existing legacy cookie functions.

## Configuration required for a later activation review

- The customer email limiter adapter requires a dedicated Durable Object namespace bound to the `CustomerEmailRateLimit` class. Check account and environment namespace ownership at activation review. A missing namespace throws, and the isolated HTTP handlers deny operations requiring a limiter when it is unavailable.
- Email request source attribution requires the existing Web Worker signing boundary plus a separate keyed source digest supplied to the resolver. Unsigned requests receive no trusted source.
- Rotating tokens require a distinct customer-session signing key. They must never use the legacy, staff or cashier signing key.
- The Web/BFF refresh and logout bridge needs an authenticated server-to-server transport and an origin check on browser mutations. The browser must receive only host-only HttpOnly cookies and never a raw credential in a response body. No activation or binding changes are included here.
