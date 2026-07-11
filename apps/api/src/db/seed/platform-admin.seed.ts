import 'dotenv/config';
import { Client } from 'pg';
import { buildDb } from '../client';
import { UserRepository } from '../../repositories/user.repository';
import { hashPassword } from '../../auth/password';
import type { PlatformRole } from '../schema/users';

const ROLE: PlatformRole = 'admin';

/**
 * Bootstraps the first Platform Admin Console account. There is no invite
 * flow for platform roles (that's a business-side concept, see
 * user-business-roles) -- without this, there is no way to log into the
 * console at all once it ships a UI (Block 5+).
 *
 * Idempotent, same as permissions.seed.ts: safe to re-run. If the email
 * already exists, this only (re)confirms its platformRole instead of
 * erroring or creating a duplicate -- covers both "first run creates the
 * account" and "role was revoked and needs restoring" without a separate
 * script.
 *
 * Reads credentials from env, never hardcodes them (see .env.example):
 *   PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD, PLATFORM_ADMIN_NAME
 * Connects directly via DATABASE_URL, same as drizzle-kit and
 * permissions.seed.ts -- not through Hyperdrive, which only exists inside a
 * deployed/dev Worker. Run with:
 *   pnpm --filter @echo-grid-feedback/api db:seed:platform-admin
 */
async function main() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const fullName = process.env.PLATFORM_ADMIN_NAME?.trim() || 'Platform Admin';

  if (!email || !password) {
    console.error(
      'Missing PLATFORM_ADMIN_EMAIL or PLATFORM_ADMIN_PASSWORD. Set both (see .env.example) and re-run.',
    );
    process.exit(1);
  }
  if (password.length < 12) {
    // Matches signupSchema's password rule (apps/api/src/auth/auth.dto.ts) --
    // platform admin credentials should meet at least the same bar as a
    // regular staff signup.
    console.error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const repo = new UserRepository(buildDb(client));

  const existing = await repo.findByEmail(email);
  if (existing) {
    if (existing.platformRole === ROLE) {
      console.log(`Platform admin already up to date (role "${ROLE}"): ${email}`);
    } else {
      // updatedBy has no system/service-account sentinel anywhere in this
      // codebase (see _shared.ts -- createdBy/updatedBy are plain nullable
      // UUIDs with no FK); the account authorizing its own bootstrap role
      // grant is the most defensible value available without inventing one.
      await repo.update(existing.id, { platformRole: ROLE }, existing.id);
      console.log(`Restored platform role "${ROLE}" on existing user: ${email}`);
    }
  } else {
    const passwordHash = await hashPassword(password);
    const created = await repo.create({
      email,
      passwordHash,
      fullName,
      status: 'active',
      emailVerifiedAt: new Date(),
      platformRole: ROLE,
    });
    console.log(`Created platform admin (role "${ROLE}"): ${created.email}`);
  }

  await client.end();
}

main().catch((err) => {
  console.error('Platform admin seed failed:', err);
  process.exit(1);
});
