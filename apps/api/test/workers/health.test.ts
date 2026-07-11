import { describe, it, expect } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index';

describe('worker smoke tests', () => {
  it('GET /health responds 200 with the expected shape', async () => {
    const request = new Request('http://example.com/health');
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'ok', service: 'echo-grid-feedback-api' });
  });

  it('a protected route with no Authorization header is rejected with 401', async () => {
    // Exercises the authenticate middleware's early-return path only, which
    // never touches Hyperdrive -- should pass even before real Cloudflare
    // resources are provisioned in wrangler.toml.
    const request = new Request('http://example.com/api/v1/businesses/me', {
      headers: { 'X-Business-Id': crypto.randomUUID() },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('GET /api/v1/branches is mounted and gated (Branch Mgmt Block 1) -- a 401, not a 404, proves the router wiring in index.ts is correct, not just that authenticate() works in the abstract', async () => {
    const request = new Request('http://example.com/api/v1/branches', {
      headers: { 'X-Business-Id': crypto.randomUUID() },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });

  it('GET /api/v1/qr/:token is mounted and genuinely PUBLIC -- no Authorization header needed, and an unknown token 404s rather than 401ing, proving no auth middleware is mounted on this route (QR Engagement Block 2)', async () => {
    const request = new Request(`http://example.com/api/v1/qr/${crypto.randomUUID()}`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    // Unlike the 401 smoke tests above, this route has no early-return
    // middleware to short-circuit on -- resolving even an unknown token
    // means a real query against HYPERDRIVE, so this one is NOT expected
    // to pass until real Cloudflare resources replace wrangler.toml's
    // placeholder Hyperdrive id (same caveat as Foundation Block 9's
    // testing notes).
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, error: { code: 'QR_CODE_NOT_FOUND' } });
  });

  it('GET /api/v1/feedback is mounted and gated (QR Engagement Block 2) -- a 401, not a 404, proves the router wiring in index.ts is correct', async () => {
    const request = new Request('http://example.com/api/v1/feedback', {
      headers: { 'X-Business-Id': crypto.randomUUID() },
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(401);
  });
});
