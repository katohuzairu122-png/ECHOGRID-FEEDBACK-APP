import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import { AppError } from '../lib/errors';
import { PASSWORD_ITERATIONS } from '../auth/password';
import type { Pbkdf2Worker } from '../auth/pbkdf2-worker';
import { createRepositories } from '../repositories';
import { auditLog, branches, businesses, permissions, refreshTokens, rolePermissions, roles, userBusinessRoles, users } from '../db/schema';
import {
  generateBusinessCode, generateInitialPassword, isAcceptablePassword, normalizeUsername,
  MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
} from './credentials';

/**
 * CASHIER-AUTH-02A (owner rulings D-1 to D-6): business-managed cashier identities.
 *
 * A managed cashier is a `users` row with NO email, owned by exactly one business (`managed_business_id`), reachable only
 * through (business code, username, password), holding only the fixed system role `Cashier` on explicitly granted branches.
 * Every mutation is tenant-pinned (`businessId` comes from the authorised tenant context, never the request body), runs in one
 * transaction with its audit row, and never logs or stores a plaintext credential. Authorisation (`cashier:manage`,
 * business-wide access, fresh re-authentication) is enforced by the route layer in front of this service; the service's own
 * tenant pinning means a wrong id is simply "not found", never another business's account.
 */
export const CASHIER_ROLE_NAME = 'Cashier';
/** D-2: the fixed permission set of the Cashier role. Identical to the default Staff counter role (D-C1): nothing administrative. */
export const CASHIER_ROLE_PERMISSIONS = ['business:view', 'branches:view', 'loyalty:serve'] as const;

/** 02B: the two branch-access configurations. Derived from the explicit grants, never stored separately, so it cannot drift. */
export type BranchAccessMode = 'single' | 'multiple';
export const MAX_ASSIGNED_BRANCHES = 50;

/** Single = exactly one branch. Multiple = two or more, each explicitly chosen. Duplicates collapse; anything else is refused. */
export function validateBranchAssignment(mode: BranchAccessMode, branchIds: readonly string[]): string[] {
  const unique = [...new Set(branchIds)];
  if (mode === 'single' && unique.length !== 1) {
    throw new AppError('Single-branch access needs exactly one branch.', 422, 'CASHIER_BRANCH_ASSIGNMENT_INVALID');
  }
  if (mode === 'multiple' && (unique.length < 2 || unique.length > MAX_ASSIGNED_BRANCHES)) {
    throw new AppError(`Multiple-branch access needs between 2 and ${MAX_ASSIGNED_BRANCHES} branches.`, 422, 'CASHIER_BRANCH_ASSIGNMENT_INVALID');
  }
  if (mode !== 'single' && mode !== 'multiple') {
    throw new AppError('Choose single-branch or multiple-branch access.', 422, 'CASHIER_BRANCH_ASSIGNMENT_INVALID');
  }
  return unique;
}

export interface ManagedCashierSummary {
  id: string;
  username: string;
  displayName: string;
  status: 'active' | 'disabled' | 'revoked';
  branches: { id: string; name: string }[];
  accessMode: BranchAccessMode | 'none';
  lastLoginAt: Date | null;
  locked: boolean;
  credentialChangedAt: Date | null;
  createdAt: Date;
}

const notFound = () => new AppError('Cashier account not found.', 404, 'CASHIER_ACCOUNT_NOT_FOUND');
const isUniqueViolation = (error: unknown): boolean => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
};

/** `users.status` carries the managed state: active, suspended (= disabled, reversible), deactivated (= revoked, terminal). */
const toStatus = (s: string): ManagedCashierSummary['status'] => (s === 'active' ? 'active' : s === 'suspended' ? 'disabled' : 'revoked');

export class ManagedCashierService {
  constructor(
    private readonly db: Database,
    private readonly hasher: Pbkdf2Worker,
  ) {}

  /** Re-checks an administrator's password (constant cost) for the 5-minute re-authentication proof. */
  async verifyAdministratorPassword(adminUserId: string, password: string): Promise<boolean> {
    const admin = await createRepositories(this.db).users.findById(adminUserId);
    // A managed identity is never an administrator. An unknown user still pays the hashing cost.
    const hash = admin && admin.managedBusinessId === null && admin.status === 'active' ? admin.passwordHash : DUMMY;
    const ok = await this.hasher.verify(password, hash);
    return ok && hash !== DUMMY;
  }

  async getBusinessCode(businessId: string): Promise<{ cashierCode: string | null; rotatedAt: Date | null }> {
    const business = await createRepositories(this.db).businesses.findById(businessId);
    if (!business) throw notFound();
    return { cashierCode: business.cashierCode, rotatedAt: business.cashierCodeRotatedAt };
  }

  /** D-3: owner-rotatable code. Rotating changes only how NEW sign-ins find the business; it is not a credential. */
  async rotateBusinessCode(input: { businessId: string; actorUserId: string }): Promise<{ cashierCode: string }> {
    return this.db.transaction(async (tx) => {
      const code = await this.assignFreshCode(tx, input.businessId);
      await tx.insert(auditLog).values({
        businessId: input.businessId, actorUserId: input.actorUserId, action: 'cashier_code.rotated',
        entityType: 'business', entityId: input.businessId, metadata: {},
      });
      return { cashierCode: code };
    });
  }

  private async assignFreshCode(tx: Transaction, businessId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateBusinessCode();
      try {
        const [row] = await tx.update(businesses)
          .set({ cashierCode: candidate, cashierCodeRotatedAt: new Date() })
          .where(and(eq(businesses.id, businessId), eq(businesses.isDeleted, false)))
          .returning({ code: businesses.cashierCode });
        if (!row?.code) throw notFound();
        return row.code;
      } catch (error) {
        // A collision on the globally unique code (vanishingly rare) retries with a new code.
        if (!isUniqueViolation(error) || attempt === 4) throw error;
      }
    }
    throw new AppError('Could not allocate a cashier code.', 409, 'CASHIER_CODE_UNAVAILABLE');
  }

  /**
   * Creates a managed cashier on the explicitly chosen branches of this business (02B: exactly one for single-branch access,
   * two or more for multiple-branch access; a branch is never added implicitly). The credential is returned exactly once and only when the service generated it; it is never stored in plaintext.
   */
  async createAccount(input: {
    businessId: string; actorUserId: string; username: string; displayName: string; branchIds: readonly string[];
    accessMode: BranchAccessMode; password?: string | undefined;
  }): Promise<{ account: ManagedCashierSummary; initialPassword: string | null; cashierCode: string }> {
    const branchIds = validateBranchAssignment(input.accessMode, input.branchIds);
    const username = normalizeUsername(input.username);
    if (!username) throw new AppError('Username must be 3 to 32 characters: lowercase letters, digits, dot, underscore or hyphen.', 422, 'CASHIER_USERNAME_INVALID');
    const displayName = input.displayName.trim();
    if (displayName.length < 1 || displayName.length > 120) throw new AppError('A display name of 1 to 120 characters is required.', 422, 'CASHIER_DISPLAY_NAME_INVALID');
    const supplied = input.password !== undefined;
    if (supplied && !isAcceptablePassword(input.password)) {
      throw new AppError(`A password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters is required.`, 422, 'CASHIER_PASSWORD_INVALID');
    }
    const password = supplied ? (input.password as string) : generateInitialPassword();
    // Hashed BEFORE the transaction: PBKDF2 is slow and must not hold row locks.
    const passwordHash = await this.hasher.hash(password, PASSWORD_ITERATIONS);

    const created = await this.db.transaction(async (tx) => {
      const business = await tx.query.businesses.findFirst({ where: and(eq(businesses.id, input.businessId), eq(businesses.isDeleted, false)) });
      if (!business || business.status !== 'active') throw new AppError('The business is not active.', 409, 'CASHIER_BUSINESS_INACTIVE');
      const chosen = await this.requireBranches(tx, input.businessId, branchIds);
      const roleId = await this.ensureCashierRole(tx, input.businessId, input.actorUserId);
      const cashierCode = business.cashierCode ?? (await this.assignFreshCode(tx, input.businessId));
      let userRow;
      try {
        [userRow] = await tx.insert(users).values({
          email: null, passwordHash, fullName: displayName, status: 'active',
          managedBusinessId: input.businessId, loginUsername: username, managedByUserId: input.actorUserId,
          credentialChangedAt: new Date(), createdBy: input.actorUserId,
        }).returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError('That username is already used in this business.', 409, 'CASHIER_USERNAME_TAKEN');
        throw error;
      }
      if (!userRow) throw new AppError('Cashier account could not be created.', 409, 'CASHIER_CREATE_FAILED');
      await tx.insert(userBusinessRoles).values(branchIds.map((branchId) => ({
        userId: userRow.id, businessId: input.businessId, branchId, roleId, createdBy: input.actorUserId,
      })));
      await tx.insert(auditLog).values({
        businessId: input.businessId, actorUserId: input.actorUserId, action: 'cashier_account.created',
        entityType: 'user', entityId: userRow.id,
        metadata: { username, accessMode: input.accessMode, branchIds, credentialSource: supplied ? 'administrator_supplied' : 'generated' },
      });
      return { userRow, cashierCode, chosen };
    });

    return {
      account: this.summarise(created.userRow, created.chosen),
      initialPassword: supplied ? null : password,
      cashierCode: created.cashierCode,
    };
  }

  /** The business's own `Cashier` system role, created on first use. Fails closed if a conflicting or altered role exists. */
  private async ensureCashierRole(tx: Transaction, businessId: string, actorUserId: string): Promise<string> {
    const existing = await tx.query.roles.findFirst({ where: and(eq(roles.businessId, businessId), eq(roles.name, CASHIER_ROLE_NAME)) });
    const catalog = await tx.select({ id: permissions.id, key: permissions.key }).from(permissions);
    const idByKey = new Map(catalog.map((p) => [p.key, p.id]));
    const wanted = CASHIER_ROLE_PERMISSIONS.map((key) => idByKey.get(key));
    if (wanted.some((id) => id === undefined)) {
      throw new AppError('The permission catalog is not seeded; cashier accounts cannot be created.', 409, 'CASHIER_CATALOG_NOT_SEEDED');
    }
    if (existing) {
      if (!existing.isSystem) throw new AppError('A custom role named Cashier already exists in this business.', 409, 'CASHIER_ROLE_NAME_CONFLICT');
      const held = await tx.select({ key: permissions.key }).from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId)).where(eq(rolePermissions.roleId, existing.id));
      const heldKeys = new Set(held.map((h) => h.key));
      const exact = heldKeys.size === CASHIER_ROLE_PERMISSIONS.length && CASHIER_ROLE_PERMISSIONS.every((k) => heldKeys.has(k));
      if (!exact) throw new AppError('The Cashier role no longer matches its fixed permission set.', 409, 'CASHIER_ROLE_ALTERED');
      return existing.id;
    }
    const [role] = await tx.insert(roles).values({ businessId, name: CASHIER_ROLE_NAME, isSystem: true, createdBy: actorUserId }).returning({ id: roles.id });
    if (!role) throw new AppError('Cashier role could not be created.', 409, 'CASHIER_CREATE_FAILED');
    await tx.insert(rolePermissions).values(wanted.map((permissionId) => ({ roleId: role.id, permissionId: permissionId as string })));
    return role.id;
  }

  private async assignedBranches(db: Pick<Database, 'select'>, businessId: string, userId: string): Promise<{ id: string; name: string }[]> {
    return db.select({ id: branches.id, name: branches.name }).from(userBusinessRoles)
      .innerJoin(branches, eq(branches.id, userBusinessRoles.branchId))
      .where(and(eq(userBusinessRoles.userId, userId), eq(userBusinessRoles.businessId, businessId),
        isNull(userBusinessRoles.deletedAt), eq(branches.isDeleted, false)))
      .orderBy(branches.name);
  }

  /** Every id must be a live branch of THIS business; a foreign, deleted or unknown id fails the whole request. */
  private async requireBranches(tx: Transaction, businessId: string, branchIds: readonly string[]): Promise<{ id: string; name: string }[]> {
    const rows = await tx.select({ id: branches.id, name: branches.name }).from(branches)
      .where(and(inArray(branches.id, [...branchIds]), eq(branches.businessId, businessId), eq(branches.isDeleted, false)));
    if (rows.length !== branchIds.length) throw new AppError('Branch not found.', 404, 'CASHIER_BRANCH_NOT_FOUND');
    return rows;
  }

  /**
   * 02B: replaces a cashier's branch assignment with exactly `branchIds`, atomically. The account row is locked first, so two
   * concurrent changes serialise. Only the sessions bound to a REMOVED branch end (at once, in the same transaction); sessions on
   * a kept branch are untouched. A new branch of the business is never added by anything except this explicit call.
   */
  async setBranchAssignments(input: {
    businessId: string; accountId: string; actorUserId: string; accessMode: BranchAccessMode; branchIds: readonly string[];
  }): Promise<ManagedCashierSummary> {
    const wanted = validateBranchAssignment(input.accessMode, input.branchIds);
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(users)
        .where(and(eq(users.id, input.accountId), eq(users.managedBusinessId, input.businessId), eq(users.isDeleted, false))).for('update');
      if (!locked) throw notFound();
      if (locked.status === 'deactivated') throw new AppError('A revoked cashier account cannot be changed.', 409, 'CASHIER_ACCOUNT_REVOKED');
      const chosen = await this.requireBranches(tx, input.businessId, wanted);
      const roleId = await this.ensureCashierRole(tx, input.businessId, input.actorUserId);
      const current = await tx.select({ branchId: userBusinessRoles.branchId }).from(userBusinessRoles)
        .where(and(eq(userBusinessRoles.userId, input.accountId), eq(userBusinessRoles.businessId, input.businessId), isNull(userBusinessRoles.deletedAt)));
      const have = new Set(current.map((c) => c.branchId).filter((b): b is string => b !== null));
      const toAdd = wanted.filter((b) => !have.has(b));
      const toRemove = [...have].filter((b) => !wanted.includes(b));
      let sessionsRevoked = 0;
      if (toAdd.length > 0 || toRemove.length > 0) {
        if (toRemove.length > 0) {
          await tx.update(userBusinessRoles).set({ deletedAt: new Date(), deletedBy: input.actorUserId })
            .where(and(eq(userBusinessRoles.userId, input.accountId), eq(userBusinessRoles.businessId, input.businessId),
              inArray(userBusinessRoles.branchId, toRemove), isNull(userBusinessRoles.deletedAt)));
          const ended = await tx.update(refreshTokens).set({ revokedAt: new Date() })
            .where(and(eq(refreshTokens.userId, input.accountId), eq(refreshTokens.client, 'cashier'),
              inArray(refreshTokens.branchId, toRemove), isNull(refreshTokens.revokedAt))).returning({ id: refreshTokens.id });
          sessionsRevoked = ended.length;
        }
        if (toAdd.length > 0) {
          await tx.insert(userBusinessRoles).values(toAdd.map((branchId) => ({
            userId: input.accountId, businessId: input.businessId, branchId, roleId, createdBy: input.actorUserId,
          })));
        }
        await tx.insert(auditLog).values({
          businessId: input.businessId, actorUserId: input.actorUserId, action: 'cashier_account.branches_changed',
          entityType: 'user', entityId: input.accountId, metadata: { accessMode: input.accessMode, added: toAdd, removed: toRemove, sessionsRevoked },
        });
      }
      return this.summarise(locked, chosen);
    });
  }

  async listAccounts(businessId: string): Promise<ManagedCashierSummary[]> {
    const repos = createRepositories(this.db);
    const accounts = await repos.users.listManagedForBusiness(businessId);
    const out: ManagedCashierSummary[] = [];
    for (const user of accounts) out.push(this.summarise(user, await this.assignedBranches(this.db, businessId, user.id)));
    return out;
  }

  /** D-5: sets a new credential and revokes every active session of this identity, in one transaction. */
  async resetCredential(input: {
    businessId: string; accountId: string; actorUserId: string; password?: string | undefined;
  }): Promise<{ initialPassword: string | null }> {
    const supplied = input.password !== undefined;
    if (supplied && !isAcceptablePassword(input.password)) {
      throw new AppError(`A password of ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters is required.`, 422, 'CASHIER_PASSWORD_INVALID');
    }
    const password = supplied ? (input.password as string) : generateInitialPassword();
    const passwordHash = await this.hasher.hash(password, PASSWORD_ITERATIONS);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.update(users).set({
        passwordHash, credentialChangedAt: new Date(), failedLoginCount: 0, failedLoginWindowStartedAt: null, lockedUntil: null,
        updatedBy: input.actorUserId, updatedAt: new Date(),
      }).where(and(eq(users.id, input.accountId), eq(users.managedBusinessId, input.businessId), eq(users.isDeleted, false), eq(users.status, 'active')))
        .returning({ id: users.id });
      if (!row) throw await this.missingOrInactive(tx, input.businessId, input.accountId);
      const revoked = await createRepositories(tx).refreshTokens.revokeAllForUser(input.accountId);
      await tx.insert(auditLog).values({
        businessId: input.businessId, actorUserId: input.actorUserId, action: 'cashier_account.credential_reset',
        entityType: 'user', entityId: input.accountId, metadata: { sessionsRevoked: revoked, credentialSource: supplied ? 'administrator_supplied' : 'generated' },
      });
    });
    return { initialPassword: supplied ? null : password };
  }

  async changeUsername(input: { businessId: string; accountId: string; actorUserId: string; username: string }): Promise<ManagedCashierSummary> {
    const username = normalizeUsername(input.username);
    if (!username) throw new AppError('Username must be 3 to 32 characters: lowercase letters, digits, dot, underscore or hyphen.', 422, 'CASHIER_USERNAME_INVALID');
    return this.db.transaction(async (tx) => {
      const before = await createRepositories(tx).users.findManagedById(input.businessId, input.accountId);
      if (!before) throw notFound();
      if (before.status === 'deactivated') throw new AppError('A revoked cashier account cannot be changed.', 409, 'CASHIER_ACCOUNT_REVOKED');
      let row;
      try {
        [row] = await tx.update(users).set({ loginUsername: username, updatedBy: input.actorUserId, updatedAt: new Date() })
          .where(and(eq(users.id, input.accountId), eq(users.managedBusinessId, input.businessId))).returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError('That username is already used in this business.', 409, 'CASHIER_USERNAME_TAKEN');
        throw error;
      }
      if (!row) throw notFound();
      await tx.insert(auditLog).values({
        businessId: input.businessId, actorUserId: input.actorUserId, action: 'cashier_account.username_changed',
        entityType: 'user', entityId: input.accountId, metadata: { from: before.loginUsername, to: username },
      });
      return this.summarise(row, await this.assignedBranches(tx, input.businessId, input.accountId));
    });
  }

  /** Disable (reversible), enable (only from disabled) or revoke (terminal). Disable and revoke end every session immediately. */
  async setStatus(input: { businessId: string; accountId: string; actorUserId: string; action: 'disable' | 'enable' | 'revoke' }): Promise<{ status: ManagedCashierSummary['status'] }> {
    const transitions = {
      disable: { from: ['active'], to: 'suspended', audit: 'cashier_account.disabled', revokeSessions: true },
      enable: { from: ['suspended'], to: 'active', audit: 'cashier_account.enabled', revokeSessions: false },
      revoke: { from: ['active', 'suspended'], to: 'deactivated', audit: 'cashier_account.revoked', revokeSessions: true },
    } as const;
    const t = transitions[input.action];
    return this.db.transaction(async (tx) => {
      const before = await createRepositories(tx).users.findManagedById(input.businessId, input.accountId);
      if (!before) throw notFound();
      // Conditional update: a concurrent or repeated call matches no row and is a clean conflict, never a double transition.
      const [row] = await tx.update(users).set({
        status: t.to, updatedBy: input.actorUserId, updatedAt: new Date(),
        ...(input.action === 'enable' ? { failedLoginCount: 0, failedLoginWindowStartedAt: null, lockedUntil: null } : {}),
      }).where(and(eq(users.id, input.accountId), eq(users.managedBusinessId, input.businessId), eq(users.isDeleted, false),
        eq(users.status, before.status))).returning({ status: users.status });
      if (!row || !(t.from as readonly string[]).includes(before.status)) {
        throw new AppError(`This account is ${toStatus(before.status)} and cannot be ${input.action}d.`, 409, 'CASHIER_ACCOUNT_STATE_CONFLICT');
      }
      const revoked = t.revokeSessions ? await createRepositories(tx).refreshTokens.revokeAllForUser(input.accountId) : 0;
      await tx.insert(auditLog).values({
        businessId: input.businessId, actorUserId: input.actorUserId, action: t.audit,
        entityType: 'user', entityId: input.accountId, metadata: { sessionsRevoked: revoked },
      });
      return { status: toStatus(row.status) };
    });
  }

  async revokeSessions(input: { businessId: string; accountId: string; actorUserId: string }): Promise<{ revoked: number }> {
    return this.db.transaction(async (tx) => {
      // SEC-CASHIER-02C-R1: the account row first, like every other revoking path, so a session being issued right now is either
      // committed (and revoked below) or refused after this commits; it can never slip past this statement.
      const [account] = await tx.select().from(users)
        .where(and(eq(users.id, input.accountId), eq(users.managedBusinessId, input.businessId), eq(users.isDeleted, false))).for('update');
      if (!account) throw notFound();
      const revoked = await createRepositories(tx).refreshTokens.revokeAllForUser(input.accountId);
      await tx.insert(auditLog).values({
        businessId: input.businessId, actorUserId: input.actorUserId, action: 'cashier_account.sessions_revoked',
        entityType: 'user', entityId: input.accountId, metadata: { sessionsRevoked: revoked },
      });
      return { revoked };
    });
  }

  private async missingOrInactive(tx: Transaction, businessId: string, accountId: string): Promise<AppError> {
    const row = await createRepositories(tx).users.findManagedById(businessId, accountId);
    return row ? new AppError('Only an active cashier account can have its credential reset.', 409, 'CASHIER_ACCOUNT_STATE_CONFLICT') : notFound();
  }

  private summarise(user: typeof users.$inferSelect, branchList: { id: string; name: string }[]): ManagedCashierSummary {
    return {
      id: user.id,
      username: user.loginUsername ?? '',
      displayName: user.fullName,
      status: toStatus(user.status),
      branches: branchList,
      accessMode: branchList.length === 0 ? 'none' : branchList.length === 1 ? 'single' : 'multiple',
      lastLoginAt: user.lastLoginAt,
      locked: user.lockedUntil !== null && user.lockedUntil > new Date(),
      credentialChangedAt: user.credentialChangedAt,
      createdAt: user.createdAt,
    };
  }
}

/** A syntactically valid hash no real credential matches, so an unknown administrator costs the same verification time. */
const DUMMY = 'pbkdf2$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
