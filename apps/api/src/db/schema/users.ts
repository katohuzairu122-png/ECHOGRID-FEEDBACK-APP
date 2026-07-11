import { pgTable, uuid, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, softDeleteColumns } from './_shared';

/**
 * Platform Admin Console roles (Platform Admin Console module, Block 1).
 * Deliberately NOT in @echo-grid-feedback/shared-types -- mirrors auth.dto.ts's
 * precedent that shared-types is for the public API contract, and platform
 * admin has no UI-facing routes yet. Move this if/when the platform admin UI
 * (Block 5+) needs it client-side.
 *
 * NULL (the default -- the column is optional) means "not a platform admin,"
 * the overwhelming majority of rows. A non-null value is layered on top of,
 * not a replacement for, business-scoped roles/permissions: it grants
 * cross-tenant platform operations (Blocks 2-4); business roles still govern
 * everything inside a single business as before. One person can hold both.
 *   - support: read-only cross-tenant visibility (business directory, audit
 *     log) plus impersonation (Block 4) for debugging a business's account.
 *   - billing: support's read-only visibility, PLUS billing/subscription
 *     management (Block 8) -- but NOT impersonation, which turned out to be
 *     orthogonal to billing once Block 4 made its actual scope concrete
 *     (viewing a business's dashboard as its staff has nothing to do with
 *     managing its subscription). "billing inherits support's access" holds
 *     for read-only visibility only, not every support capability.
 *   - admin: full platform control, including suspending businesses,
 *     impersonation, and granting/revoking other users' platformRole.
 * Not a hierarchy at the type level -- requirePlatformRole checks membership
 * in an explicit allow-list per route, so a route restricted to ['billing']
 * does not silently admit 'admin' unless the route lists it too.
 */
export const PLATFORM_ROLES = ['support', 'billing', 'admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * A platform user with dashboard access (owner, manager, staff) -- NOT a
 * customer. End-consumer/loyalty profiles are a separate concern introduced
 * in the future Loyalty feature module. A user's businesses and permissions
 * come entirely from userBusinessRoles, not a column here, because one
 * person can hold different roles at different businesses or branches.
 * platformRole is the one deliberate exception: it is cross-tenant by
 * definition, so it cannot live in a business-scoped table (see comment
 * above).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    status: text('status').notNull().default('invited'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    platformRole: text('platform_role').$type<PlatformRole>(),
    ...auditColumns,
    ...softDeleteColumns,
  },
  (table) => [
    check(
      'users_status_check',
      sql`${table.status} IN ('invited', 'active', 'suspended', 'deactivated')`,
    ),
    // NULL (not a platform admin) or one of PLATFORM_ROLES above -- keep
    // this value list in lockstep with that array. Same defense-in-depth
    // pattern as businesses_default_locale_check: enforced at the DB layer
    // independently of any app-layer check.
    check(
      'users_platform_role_check',
      sql`${table.platformRole} IS NULL OR ${table.platformRole} IN ('support', 'billing', 'admin')`,
    ),
  ],
);
