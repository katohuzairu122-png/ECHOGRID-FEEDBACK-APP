import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService, AuthError } from './auth.service';
import type { User, NewUser } from '../repositories/user.repository';
import type { RefreshToken, NewRefreshToken } from '../repositories/refresh-token.repository';

/**
 * Minimal in-memory fakes -- just enough of the repository interface for
 * AuthService to run against, nothing more. This is what constructor
 * injection (Block 4) buys: these tests never touch a real database or a
 * running Worker.
 */
function createFakeRepos() {
  const users = new Map<string, User>();
  const refreshTokens = new Map<string, RefreshToken>();

  return {
    users: {
      async findByEmail(email: string) {
        return [...users.values()].find((u) => u.email === email);
      },
      async findById(id: string) {
        return users.get(id);
      },
      async create(input: NewUser): Promise<User> {
        const user: User = {
          id: (input.id as string) ?? crypto.randomUUID(),
          email: input.email,
          emailVerifiedAt: null,
          passwordHash: input.passwordHash,
          fullName: input.fullName,
          phone: input.phone ?? null,
          platformRole: input.platformRole ?? null,
          status: input.status ?? 'invited',
          lastLoginAt: null,
          createdAt: new Date(),
          createdBy: input.createdBy ?? null,
          updatedAt: new Date(),
          updatedBy: input.updatedBy ?? null,
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
        };
        users.set(user.id, user);
        return user;
      },
      async touchLastLogin(id: string) {
        const user = users.get(id);
        if (user) user.lastLoginAt = new Date();
      },
    },
    refreshTokens: {
      async create(input: NewRefreshToken): Promise<RefreshToken> {
        const row: RefreshToken = {
          id: (input.id as string) ?? crypto.randomUUID(),
          userId: input.userId,
          tokenHash: input.tokenHash,
          issuedAt: new Date(),
          expiresAt: input.expiresAt,
          revokedAt: null,
          replacedByTokenId: null,
          userAgent: input.userAgent ?? null,
          ipAddress: input.ipAddress ?? null,
        };
        refreshTokens.set(row.id, row);
        return row;
      },
      async findById(id: string) {
        return refreshTokens.get(id);
      },
      async rotate(id: string, replacedByTokenId: string) {
        const row = refreshTokens.get(id);
        if (row) {
          row.revokedAt = new Date();
          row.replacedByTokenId = replacedByTokenId;
        }
      },
      async revoke(id: string) {
        const row = refreshTokens.get(id);
        if (row) row.revokedAt = new Date();
      },
      async listActiveForUser(userId: string) {
        return [...refreshTokens.values()].filter((r) => r.userId === userId && !r.revokedAt);
      },
    },
  };
}

const SECRETS = { JWT_ACCESS_SECRET: 'access-secret', JWT_REFRESH_SECRET: 'refresh-secret' };

describe('AuthService', () => {
  let repos: ReturnType<typeof createFakeRepos>;
  let service: AuthService;

  beforeEach(() => {
    repos = createFakeRepos();
    // The fakes implement only the subset AuthService uses; the concrete
    // repositories also carry a `protected db` no object literal can match,
    // so inject through the constructor's declared param type.
    service = new AuthService(
      repos as unknown as ConstructorParameters<typeof AuthService>[0],
      SECRETS,
    );
  });

  it('signup creates a user (with a hashed, not raw, password) and returns tokens', async () => {
    const tokens = await service.signup({
      email: 'new@example.com',
      password: 'a-strong-password',
      fullName: 'New User',
    });
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();

    const stored = await repos.users.findByEmail('new@example.com');
    expect(stored?.passwordHash).not.toBe('a-strong-password');
  });

  it('signup rejects a duplicate email', async () => {
    await service.signup({ email: 'dup@example.com', password: 'password-one', fullName: 'A' });
    await expect(
      service.signup({ email: 'dup@example.com', password: 'password-two', fullName: 'B' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('login succeeds with the right password and fails with the wrong one', async () => {
    await service.signup({
      email: 'user@example.com',
      password: 'correct-password',
      fullName: 'U',
    });

    await expect(
      service.login({ email: 'user@example.com', password: 'correct-password' }),
    ).resolves.toMatchObject({ accessToken: expect.any(String) });

    await expect(
      service.login({ email: 'user@example.com', password: 'wrong-password' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('login gives the same error for a missing account and a wrong password (no user enumeration)', async () => {
    await service.signup({ email: 'real@example.com', password: 'real-password', fullName: 'R' });

    const missingAccount = (await service
      .login({ email: 'nobody@example.com', password: 'anything' })
      .catch((err) => err)) as AuthError;
    const wrongPassword = (await service
      .login({ email: 'real@example.com', password: 'wrong' })
      .catch((err) => err)) as AuthError;

    expect(missingAccount.message).toBe(wrongPassword.message);
    expect(missingAccount.code).toBe(wrongPassword.code);
  });

  it('refresh rotates the token: the old one stops working, the new one works', async () => {
    const first = await service.signup({
      email: 'rotate@example.com',
      password: 'password-123',
      fullName: 'R',
    });

    const second = await service.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // The old, now-rotated token must be rejected -- this is what catches a
    // stolen-and-replayed refresh token.
    await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });

    await expect(service.refresh(second.refreshToken)).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
  });

  it('logout revokes the refresh token so it can no longer be used', async () => {
    const tokens = await service.signup({
      email: 'logout@example.com',
      password: 'password-123',
      fullName: 'L',
    });

    await service.logout(tokens.refreshToken);

    await expect(service.refresh(tokens.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });

  it('logout is idempotent -- logging out twice does not throw', async () => {
    const tokens = await service.signup({
      email: 'idempotent@example.com',
      password: 'password-123',
      fullName: 'I',
    });
    await service.logout(tokens.refreshToken);
    await expect(service.logout(tokens.refreshToken)).resolves.toBeUndefined();
  });
});
