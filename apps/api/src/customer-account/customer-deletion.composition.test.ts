import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createCustomerDeletionComposition } from './customer-deletion.composition';

describe('customer deletion composition gate', () => {
  it('returns generic 404 before runtime or DB access when separate deletion activation is absent', async () => {
    const open = vi.fn();
    const app = new Hono();
    app.route('/customer-account', createCustomerDeletionComposition({
      isEnabled: (c) => c.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true' && c.env.CUSTOMER_DELETION_ENABLED === 'true',
      open,
    }));
    const res = await app.request('/customer-account/deletion', { method: 'GET' }, {
      CUSTOMER_EMAIL_AUTH_ENABLED: 'true',
    });
    expect(res.status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });
});
