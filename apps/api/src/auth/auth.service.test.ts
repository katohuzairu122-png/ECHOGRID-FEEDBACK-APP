import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService, AuthError } from './auth.service';
import { createDirectPbkdf2Worker } from './pbkdf2-worker';
import type { User, NewUser } from '../repositories/user.repository';
import type { RefreshToken, NewRefreshToken } from '../repositories/refresh-token.repository';
import type {
  PasswordResetToken,
  NewPasswordResetToken,
} from '../repositories/password-reset-token.repository';
import type { EmailMessage } from '../notifications/email.service';

/**
 * Minimal in-memory fakes -- just enough of the repository interface for
 * AuthService to run against, nothing more. This is what constructor
 * injection (Block 4) buys: these tests never touch a real database or a
 * running Worker.
 */
function createFakeRepos() {
  const users = new Map<string, User>();
  const refreshTokens = new Map<string, RefreshToken>();
  const passwordResetTokens = new Map<string, PasswordResetToken>();

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
      async update(id: string, patch: Partial<User>, _updatedBy: string) {
        const user = users.get(id);
        if (!user) return undefined;
        Object.assign(user, patch);
        return user;
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
      async revokeAllForUser(userId: string) {
        const active = [...refreshTokens.values()].filter((r) => r.userId === userId && !r.revokedAt);
        for (const row of active) row.revokedAt = new Date();
        return active.length;
      },
    },
    passwordResetTokens: {
      async create(input: NewPasswordResetToken): Promise<PasswordResetToken> {
        const row: PasswordResetToken = {
          id: (input.id as string) ?? crypto.randomUUID(),
          userId: input.userId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          consumedAt: input.consumedAt ?? null,
          invalidatedAt: input.invalidatedAt ?? null,
          requestedIp: input.requestedIp ?? null,
          createdAt: new Date(),
        };
        passwordResetTokens.set(row.id, row);
        return row;
      },
      async findByTokenHash(tokenHash: string) {
        return [...passwordResetTokens.values()].find((t) => t.tokenHash === tokenHash);
      },
      // Mirrors the repository's guarded `WHERE consumed_at IS NULL` update
      // -- returning false on an already-consumed row is the behaviour the
      // concurrent-redemption test below depends on.
      async consume(id: string) {
        const row = passwordResetTokens.get(id);
        if (!row || row.consumedAt) return false;
        row.consumedAt = new Date();
        return true;
      },
      async invalidateAllForUser(userId: string) {
        for (const row of passwordResetTokens.values()) {
          if (row.userId === userId && !row.consumedAt && !row.invalidatedAt) {
            row.invalidatedAt = new Date();
          }
        }
      },
    },
    // Exposed so tests can assert on issued tokens without reaching through
    // the repository fakes' public surface.
    _rawResetTokens: passwordResetTokens,
  };
}

/** Captures sends instead of delivering, so tests can read the reset link
 * out of the email exactly the way a real user would. */
function createFakeEmailService() {
  const sent: EmailMessage[] = [];
  return {
    sent,
    service: {
      async send(message: EmailMessage) {
        sent.push(message);
      },
    },
  };
}

const WEB_BASE_URL = 'https://app.test';

const SECRETS = { JWT_ACCESS_SECRET: 'access-secret', JWT_REFRESH_SECRET: 'refresh-secret' };

describe('AuthService', () => {
  let repos: ReturnType<typeof createFakeRepos>;
  let service: AuthService;
  let email: ReturnType<typeof createFakeEmailService>;

  beforeEach(() => {
    repos = createFakeRepos();
    email = createFakeEmailService();
    // The fakes implement only the subset AuthService uses; the concrete
    // repositories also carry a `protected db` no object literal can match,
    // so inject through the constructor's declared param type.
    service = new AuthService(
      repos as unknown as ConstructorParameters<typeof AuthService>[0],
      SECRETS,
      createDirectPbkdf2Worker(),
      { email: email.service, webBaseUrl: WEB_BASE_URL },
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

  it('refresh rejects a valid token once the account is deactivated -- a suspended user cannot keep renewing an existing session', async () => {
    const tokens = await service.signup({
      email: 'deactivated@example.com',
      password: 'password-123',
      fullName: 'D',
    });
    const user = await repos.users.findByEmail('deactivated@example.com');
    await repos.users.update(user!.id, { status: 'suspended' }, user!.id);

    await expect(service.refresh(tokens.refreshToken)).rejects.toMatchObject({
      code: 'ACCOUNT_INACTIVE',
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
  // --- Password reset & change (Block 1.5) ---------------------------------

  /** Signs a user up and returns the raw reset token that was emailed to
   * them -- the only place it exists in plaintext, exactly as for a real
   * user. Parsed out of the link rather than read from the DB fake, so the
   * test exercises the same path a user actually takes. */
  async function signupAndRequestReset(email_: string, password = 'original-password-1') {
    await service.signup({ email: email_, password, fullName: 'Reset User' });
    email.sent.length = 0;
    await service.requestPasswordReset({ email: email_ });
    const last = email.sent.at(-1);
    const match = last?.html.match(/[?&]token=([a-f0-9]+)/);
    return { rawToken: match?.[1] ?? '', message: last };
  }

  it('requestPasswordReset emails a link containing a token', async () => {
    const { rawToken, message } = await signupAndRequestReset('reset@example.com');

    expect(message?.to).toBe('reset@example.com');
    expect(rawToken).toHaveLength(64);
    expect(message?.html).toContain(`${WEB_BASE_URL}/reset-password?token=`);
  });

  it('stores the reset token hashed, never raw', async () => {
    const { rawToken } = await signupAndRequestReset('hashed@example.com');
    const stored = [...repos._rawResetTokens.values()];

    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).not.toBe(rawToken);
    expect(stored[0]?.tokenHash).toBeTruthy();
  });

  it('requestPasswordReset stays silent for an unknown email (no enumeration)', async () => {
    await expect(
      service.requestPasswordReset({ email: 'nobody@example.com' }),
    ).resolves.toBeUndefined();
    expect(email.sent).toHaveLength(0);
  });

  it('requestPasswordReset stays silent for a deactivated account', async () => {
    await service.signup({
      email: 'inactive@example.com',
      password: 'original-password-1',
      fullName: 'X',
    });
    const user = await repos.users.findByEmail('inactive@example.com');
    await repos.users.update(user!.id, { status: 'suspended' }, user!.id);
    email.sent.length = 0;

    await service.requestPasswordReset({ email: 'inactive@example.com' });
    expect(email.sent).toHaveLength(0);
  });

  it('requesting a second reset invalidates the first link', async () => {
    const first = await signupAndRequestReset('twice@example.com');
    await service.requestPasswordReset({ email: 'twice@example.com' });

    await expect(
      service.resetPassword({ token: first.rawToken, newPassword: 'brand-new-password-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
  });

  it('resetPassword sets the new password and rejects the old one', async () => {
    const { rawToken } = await signupAndRequestReset('happy@example.com');

    await service.resetPassword({ token: rawToken, newPassword: 'brand-new-password-1' });

    await expect(
      service.login({ email: 'happy@example.com', password: 'original-password-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(
      service.login({ email: 'happy@example.com', password: 'brand-new-password-1' }),
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it('a reset link is single use', async () => {
    const { rawToken } = await signupAndRequestReset('single@example.com');
    await service.resetPassword({ token: rawToken, newPassword: 'brand-new-password-1' });

    await expect(
      service.resetPassword({ token: rawToken, newPassword: 'another-password-99' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
  });

  /** The race the guarded `WHERE consumed_at IS NULL` update exists to stop
   * -- the sequential single-use test above cannot catch it by construction,
   * which is the same gap docs/SECURITY-REVIEW.md called out for loyalty
   * redemption. */
  it('two concurrent redemptions of one link -- exactly one succeeds', async () => {
    const { rawToken } = await signupAndRequestReset('race@example.com');

    const results = await Promise.allSettled([
      service.resetPassword({ token: rawToken, newPassword: 'first-new-password-1' }),
      service.resetPassword({ token: rawToken, newPassword: 'second-new-password-2' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('rejects an expired reset token', async () => {
    const { rawToken } = await signupAndRequestReset('expired@example.com');
    for (const row of repos._rawResetTokens.values()) {
      row.expiresAt = new Date(Date.now() - 1000);
    }

    await expect(
      service.resetPassword({ token: rawToken, newPassword: 'brand-new-password-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
  });

  it('rejects an unknown reset token with the same error as an expired one', async () => {
    await expect(
      service.resetPassword({ token: 'f'.repeat(64), newPassword: 'brand-new-password-1' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
  });

  it('rejects a reset for an account deactivated after the link was issued', async () => {
    const { rawToken } = await signupAndRequestReset('deactivated@example.com');
    const user = await repos.users.findByEmail('deactivated@example.com');
    await repos.users.update(user!.id, { status: 'suspended' }, user!.id);

    await expect(
      service.resetPassword({ token: rawToken, newPassword: 'brand-new-password-1' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('resetPassword revokes every existing session', async () => {
    await service.signup({
      email: 'sessions@example.com',
      password: 'original-password-1',
      fullName: 'S',
    });
    const live = await service.login({
      email: 'sessions@example.com',
      password: 'original-password-1',
    });
    email.sent.length = 0;
    await service.requestPasswordReset({ email: 'sessions@example.com' });
    const rawToken = email.sent.at(-1)?.html.match(/[?&]token=([a-f0-9]+)/)?.[1] ?? '';

    await service.resetPassword({ token: rawToken, newPassword: 'brand-new-password-1' });

    await expect(service.refresh(live.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });

  it('sends a confirmation email after a successful reset', async () => {
    const { rawToken } = await signupAndRequestReset('confirm@example.com');
    email.sent.length = 0;

    await service.resetPassword({ token: rawToken, newPassword: 'brand-new-password-1' });

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.subject).toMatch(/password was changed/i);
  });

  it('changePassword requires the current password', async () => {
    await service.signup({
      email: 'change@example.com',
      password: 'original-password-1',
      fullName: 'C',
    });
    const user = await repos.users.findByEmail('change@example.com');

    await expect(
      service.changePassword({
        userId: user!.id,
        currentPassword: 'wrong-password-xx',
        newPassword: 'brand-new-password-1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('changePassword updates the password and revokes every session', async () => {
    await service.signup({
      email: 'changeok@example.com',
      password: 'original-password-1',
      fullName: 'C',
    });
    const live = await service.login({
      email: 'changeok@example.com',
      password: 'original-password-1',
    });
    const user = await repos.users.findByEmail('changeok@example.com');

    await service.changePassword({
      userId: user!.id,
      currentPassword: 'original-password-1',
      newPassword: 'brand-new-password-1',
    });

    await expect(service.refresh(live.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    await expect(
      service.login({ email: 'changeok@example.com', password: 'brand-new-password-1' }),
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  /** A confirmation-email outage must not undo a password the user has
   * already successfully changed -- the deliberate asymmetry with
   * requestPasswordReset, where a send failure does surface. */
  it('a failing confirmation email does not roll back the password change', async () => {
    const { rawToken } = await signupAndRequestReset('mailfail@example.com');
    email.service.send = async () => {
      throw new Error('Email delivery failed with status 500');
    };

    await expect(
      service.resetPassword({ token: rawToken, newPassword: 'brand-new-password-1' }),
    ).resolves.toBeUndefined();
    await expect(
      service.login({ email: 'mailfail@example.com', password: 'brand-new-password-1' }),
    ).resolves.toMatchObject({ accessToken: expect.any(String) });
  });
});
