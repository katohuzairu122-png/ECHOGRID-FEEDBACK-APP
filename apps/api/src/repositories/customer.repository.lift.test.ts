import { describe, it, expect, vi } from 'vitest';
import { CustomerRepository } from './customer.repository';

/**
 * A timed suspension ends by itself: the lookups every access check goes
 * through reinstate a customer whose suspension period has passed, and leave
 * every other state alone. Uses a minimal fake of the Drizzle calls involved.
 */
function fakeDb(row: Record<string, unknown>) {
  const inserted: unknown[] = [];
  const updated = vi.fn();
  const db = {
    query: { customers: { findFirst: vi.fn(async () => row) } },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            updated(patch);
            return [{ ...row, ...patch }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: async (v: unknown) => {
        inserted.push(v);
      },
    }),
  };
  return { db, inserted, updated };
}

const base = { id: 'c1', phone: '+96555551234', isDeleted: false };

describe('CustomerRepository timed suspension', () => {
  it('reinstates a customer whose suspension has ended and records it', async () => {
    const { db, inserted, updated } = fakeDb({
      ...base,
      status: 'suspended',
      suspendedUntil: new Date(Date.now() - 1000),
    });
    const result = await new CustomerRepository(db as never).findById('c1');
    expect(result?.status).toBe('active');
    expect(updated).toHaveBeenCalledWith({ status: 'active', suspendedUntil: null });
    expect(inserted).toEqual([expect.objectContaining({ customerId: 'c1', action: 'lift' })]);
  });

  it('keeps a customer suspended while the period is still running', async () => {
    const { db, updated } = fakeDb({
      ...base,
      status: 'suspended',
      suspendedUntil: new Date(Date.now() + 86_400_000),
    });
    const result = await new CustomerRepository(db as never).findById('c1');
    expect(result?.status).toBe('suspended');
    expect(updated).not.toHaveBeenCalled();
  });

  it('never reinstates a banned customer, or touches an active one', async () => {
    for (const status of ['banned', 'active']) {
      const { db, updated } = fakeDb({
        ...base,
        status,
        suspendedUntil: new Date(Date.now() - 1000),
      });
      const result = await new CustomerRepository(db as never).findByPhone('+96555551234');
      expect(result?.status).toBe(status);
      expect(updated).not.toHaveBeenCalled();
    }
  });
});
