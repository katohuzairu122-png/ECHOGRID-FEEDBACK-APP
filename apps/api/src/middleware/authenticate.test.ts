import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { User } from '../repositories/user.repository';

const mocks = vi.hoisted(() => ({
  findById: vi.fn<(id: string) => Promise<User | undefined>>(),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: mocks.close })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({ users: { findById: mocks.findById } })),
}));

const { authenticate } = await import('./authenticate');
const { signAccessToken, signImpersonationToken } = await import('../auth/jwt');
const { errorHandler } = await import('../lib/error-handler');

const JWT_SECRET = 'test-only-access-secret';
const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const env = {
  JWT_ACCESS_SECRET: JWT_SECRET,
  HYPERDRIVE: { connectionString: 'postgresql://unused' },
} as unknown as Bindings;

const app = new Hono<{ Bindings: Bindings }>();
app.get('/protected', authenticate, (c) =>
  c.json({ userId: c.get('userId'), impersonatedBy: c.get('impersonatedBy') ?? null }),
);
app.onError(errorHandler);

function user(id: string, status: User['status'] = 'active'): User {
  return {
    id,
    email: `${id}@example.test`,
    emailVerifiedAt: null,
    passwordHash: 'hash',
    fullName: 'Test User',
    phone: null,
    platformRole: null,
    status,
    lastLoginAt: null,
    createdAt: new Date(),
    createdBy: null,
    updatedAt: new Date(),
    updatedBy: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
  };
}

function executionCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

async function request(token: string): Promise<Response> {
  return app.request(
    '/protected',
    { headers: { authorization: `Bearer ${token}` } },
    env,
    executionCtx(),
  );
}

describe('authenticate account-state enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockImplementation(async (id) => user(id));
  });

  it('accepts an active user and exposes the verified subject', async () => {
    const response = await request(await signAccessToken(SUBJECT_ID, JWT_SECRET));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userId: SUBJECT_ID, impersonatedBy: null });
  });

  it.each(['suspended', 'deactivated', 'invited'] as const)(
    'rejects a %s user holding an otherwise valid access token',
    async (status) => {
      mocks.findById.mockResolvedValue(user(SUBJECT_ID, status));

      const response = await request(await signAccessToken(SUBJECT_ID, JWT_SECRET));

      expect(response.status).toBe(401);
    },
  );

  it('rejects a missing or soft-deleted user excluded by the repository', async () => {
    mocks.findById.mockResolvedValue(undefined);

    const response = await request(await signAccessToken(SUBJECT_ID, JWT_SECRET));

    expect(response.status).toBe(401);
  });

  it('accepts impersonation only while both target and actor are active', async () => {
    const { token } = await signImpersonationToken(SUBJECT_ID, ACTOR_ID, JWT_SECRET);
    const response = await request(token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      userId: SUBJECT_ID,
      impersonatedBy: ACTOR_ID,
    });
    expect(mocks.findById).toHaveBeenNthCalledWith(1, SUBJECT_ID);
    expect(mocks.findById).toHaveBeenNthCalledWith(2, ACTOR_ID);
  });

  it('rejects impersonation when the target becomes inactive', async () => {
    mocks.findById.mockImplementation(async (id) =>
      id === SUBJECT_ID ? user(id, 'suspended') : user(id),
    );
    const { token } = await signImpersonationToken(SUBJECT_ID, ACTOR_ID, JWT_SECRET);

    expect((await request(token)).status).toBe(401);
    expect(mocks.findById).toHaveBeenCalledTimes(1);
  });

  it('rejects impersonation when the platform actor becomes inactive', async () => {
    mocks.findById.mockImplementation(async (id) =>
      id === ACTOR_ID ? user(id, 'deactivated') : user(id),
    );
    const { token } = await signImpersonationToken(SUBJECT_ID, ACTOR_ID, JWT_SECRET);

    expect((await request(token)).status).toBe(401);
    expect(mocks.findById).toHaveBeenCalledTimes(2);
  });
});
