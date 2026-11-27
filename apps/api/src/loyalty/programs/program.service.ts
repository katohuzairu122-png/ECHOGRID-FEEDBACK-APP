import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  isProgramAvailable,
  programRegistry,
  validateProgramConfig,
  type LoyaltyProgramStatus,
  type LoyaltyProgramType,
  type ProgramConfigIssue,
} from '@echo-grid-feedback/shared-types';
import type { Database } from '../../db/client';
import {
  businesses,
  loyaltyRewards,
  loyaltyProgramEvents,
  loyaltyProgramProgress,
  loyaltyProgramSetup,
  loyaltyProgramVersions,
  loyaltyPrograms,
  roles,
  userBusinessRoles,
} from '../../db/schema';
import { AppError } from '../../lib/errors';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Database | Tx;

export type LoyaltyProgramRow = typeof loyaltyPrograms.$inferSelect;

/** What the earning engine should use for a business right now. */
export type ResolvedProgramme =
  | { kind: 'programme'; programId: string; version: number; type: LoyaltyProgramType; config: Record<string, unknown>; legacy: boolean }
  /** A business that predates programmes and has no programme row at all: it earns under its loyalty_settings, exactly as before. */
  | { kind: 'implicit_legacy' }
  /** A business that chose Configure Later, or paused every programme: it earns nothing from purchases or check-ins until one is active. */
  | { kind: 'none' };

export interface ProgrammeView extends LoyaltyProgramRow {
  config: Record<string, unknown>;
}

const OWNER_ROLE_NAME = 'Owner';

/** Resolves the active primary programme for a business. Server-side only: no caller (cashier or customer) can influence the result. */
export async function resolveActiveProgramme(db: Executor, businessId: string): Promise<ResolvedProgramme> {
  const [active] = await db
    .select({
      programId: loyaltyPrograms.id,
      version: loyaltyPrograms.currentVersion,
      type: loyaltyPrograms.type,
      legacy: loyaltyPrograms.legacy,
      config: loyaltyProgramVersions.config,
    })
    .from(loyaltyPrograms)
    .innerJoin(
      loyaltyProgramVersions,
      and(eq(loyaltyProgramVersions.programId, loyaltyPrograms.id), eq(loyaltyProgramVersions.version, loyaltyPrograms.currentVersion)),
    )
    .where(and(eq(loyaltyPrograms.businessId, businessId), eq(loyaltyPrograms.status, 'active')))
    .limit(1);
  if (active) return { kind: 'programme', ...active };
  const [anyProgramme] = await db.select({ id: loyaltyPrograms.id }).from(loyaltyPrograms).where(eq(loyaltyPrograms.businessId, businessId)).limit(1);
  const [setup] = await db.select({ state: loyaltyProgramSetup.state }).from(loyaltyProgramSetup).where(eq(loyaltyProgramSetup.businessId, businessId)).limit(1);
  return anyProgramme || setup ? { kind: 'none' } : { kind: 'implicit_legacy' };
}

export class LoyaltyProgramService {
  constructor(private readonly db: Database) {}

  /** The eight programme cards: availability comes from the canonical registry, never from the client. */
  registry() {
    return programRegistry();
  }

  async list(businessId: string): Promise<ProgrammeView[]> {
    const rows = await this.db
      .select({ program: loyaltyPrograms, config: loyaltyProgramVersions.config })
      .from(loyaltyPrograms)
      .innerJoin(
        loyaltyProgramVersions,
        and(eq(loyaltyProgramVersions.programId, loyaltyPrograms.id), eq(loyaltyProgramVersions.version, loyaltyPrograms.currentVersion)),
      )
      .where(eq(loyaltyPrograms.businessId, businessId))
      .orderBy(desc(loyaltyPrograms.createdAt));
    return rows.map((r) => ({ ...r.program, config: r.config }));
  }

  async get(businessId: string, programId: string): Promise<ProgrammeView> {
    const found = (await this.list(businessId)).find((p) => p.id === programId);
    if (!found) throw new AppError('Programme not found.', 404, 'PROGRAM_NOT_FOUND');
    return found;
  }

  async history(businessId: string, programId: string) {
    await this.get(businessId, programId);
    const events = await this.db
      .select()
      .from(loyaltyProgramEvents)
      .where(and(eq(loyaltyProgramEvents.businessId, businessId), eq(loyaltyProgramEvents.programId, programId)))
      .orderBy(asc(loyaltyProgramEvents.createdAt));
    const versions = await this.db
      .select()
      .from(loyaltyProgramVersions)
      .where(and(eq(loyaltyProgramVersions.businessId, businessId), eq(loyaltyProgramVersions.programId, programId)))
      .orderBy(asc(loyaltyProgramVersions.version));
    return { events, versions };
  }

  /** Creates a draft programme with configuration version 1. Only an AVAILABLE type with a valid configuration is accepted. */
  async createDraft(businessId: string, actorUserId: string, input: { type: string; config: unknown }): Promise<ProgrammeView> {
    return this.db.transaction(async (tx) => {
      await this.lockBusiness(tx, businessId);
      const currency = await this.currencyOf(tx, businessId);
      const checked = this.requireValidConfig(input.type, input.config, currency);
      await this.requireValidReferences(tx, businessId, input.type, checked);
      const [program] = await tx
        .insert(loyaltyPrograms)
        .values({ businessId, type: input.type as LoyaltyProgramType, status: 'draft', currentVersion: 1, createdBy: actorUserId })
        .returning();
      if (!program) throw new Error('Insert returned no row');
      await this.insertVersion(tx, program, 1, checked, actorUserId);
      await this.recordEvent(tx, program, { eventType: 'created', toStatus: 'draft', version: 1, actorUserId });
      return { ...program, config: checked };
    });
  }

  /** Saves a configuration as a NEW immutable version. A validated programme returns to draft; an active one keeps running, with the new
   * version applying to future events only. Retired and inactive programmes cannot be edited. */
  async saveConfig(businessId: string, actorUserId: string, programId: string, config: unknown): Promise<ProgrammeView> {
    return this.db.transaction(async (tx) => {
      await this.lockBusiness(tx, businessId);
      const program = await this.lockProgram(tx, businessId, programId);
      if (!['draft', 'validated', 'active'].includes(program.status)) {
        throw new AppError('Only a draft, validated or active programme can be edited.', 409, 'PROGRAM_NOT_EDITABLE');
      }
      const currency = await this.currencyOf(tx, businessId);
      const checked = this.requireValidConfig(program.type, config, currency);
      await this.requireValidReferences(tx, businessId, program.type, checked);
      const version = program.currentVersion + 1;
      await this.insertVersion(tx, program, version, checked, actorUserId);
      const nextStatus: LoyaltyProgramStatus = program.status === 'active' ? 'active' : 'draft';
      const [updated] = await tx
        .update(loyaltyPrograms)
        .set({ currentVersion: version, status: nextStatus, updatedAt: new Date() })
        .where(eq(loyaltyPrograms.id, program.id))
        .returning();
      if (!updated) throw new Error('Update returned no row');
      await this.recordEvent(tx, updated, { eventType: 'version_created', fromStatus: program.status, toStatus: nextStatus, version, actorUserId });
      return { ...updated, config: checked };
    });
  }

  /** draft -> validated: the server re-checks the stored configuration; nothing is trusted from the screen. */
  async validate(businessId: string, actorUserId: string, programId: string): Promise<ProgrammeView> {
    return this.db.transaction(async (tx) => {
      await this.lockBusiness(tx, businessId);
      const program = await this.lockProgram(tx, businessId, programId);
      if (program.status !== 'draft') throw new AppError('Only a draft programme can be validated.', 409, 'PROGRAM_NOT_VALIDATABLE');
      const config = await this.currentConfig(tx, program);
      const currency = await this.currencyOf(tx, businessId);
      await this.requireValidReferences(tx, businessId, program.type, this.requireValidConfig(program.type, config, currency));
      const [updated] = await tx.update(loyaltyPrograms).set({ status: 'validated', updatedAt: new Date() }).where(eq(loyaltyPrograms.id, program.id)).returning();
      if (!updated) throw new Error('Update returned no row');
      await this.recordEvent(tx, updated, { eventType: 'validated', fromStatus: 'draft', toStatus: 'validated', version: updated.currentVersion, actorUserId });
      return { ...updated, config };
    });
  }

  /**
   * Activates a validated (or paused) programme, switching away from the currently active one in the SAME transaction. Only the business
   * Owner may do this. Balances, ledger rows, rewards, tiers and the previous programme's history are untouched; the previous programme's
   * progress is frozen, never converted. If anything fails the whole transaction rolls back and the previous programme stays active.
   */
  async activate(businessId: string, actorUserId: string, programId: string): Promise<{ activated: ProgrammeView; previous: LoyaltyProgramRow | null }> {
    return this.db.transaction(async (tx) => {
      await this.lockBusiness(tx, businessId);
      await this.requireOwner(tx, actorUserId, businessId);
      const target = await this.lockProgram(tx, businessId, programId);
      if (!['validated', 'inactive'].includes(target.status)) {
        throw new AppError('Only a validated or paused programme can be activated.', 409, 'PROGRAM_NOT_ACTIVATABLE');
      }
      if (!isProgramAvailable(target.type)) {
        throw new AppError('This programme is not available for activation.', 422, 'PROGRAM_UNAVAILABLE');
      }
      const config = await this.currentConfig(tx, target);
      await this.requireValidReferences(tx, businessId, target.type, this.requireValidConfig(target.type, config, await this.currencyOf(tx, businessId)));

      const now = new Date();
      const [current] = await tx
        .select()
        .from(loyaltyPrograms)
        .where(and(eq(loyaltyPrograms.businessId, businessId), eq(loyaltyPrograms.status, 'active')))
        .for('update');
      let previous: LoyaltyProgramRow | null = null;
      if (current) {
        const [paused] = await tx
          .update(loyaltyPrograms)
          .set({ status: 'inactive', deactivatedAt: now, updatedAt: now })
          .where(eq(loyaltyPrograms.id, current.id))
          .returning();
        if (!paused) throw new Error('Update returned no row');
        previous = paused;
        await tx.update(loyaltyProgramProgress).set({ frozenAt: now, updatedAt: now }).where(and(eq(loyaltyProgramProgress.programId, current.id), sql`${loyaltyProgramProgress.frozenAt} IS NULL`));
        await this.recordEvent(tx, paused, { eventType: 'switched_from', fromStatus: 'active', toStatus: 'inactive', version: paused.currentVersion, actorUserId, metadata: { replacedBy: target.id } });
      }
      const [activated] = await tx
        .update(loyaltyPrograms)
        .set({ status: 'active', activatedBy: actorUserId, activatedAt: now, deactivatedAt: null, updatedAt: now })
        .where(eq(loyaltyPrograms.id, target.id))
        .returning();
      if (!activated) throw new Error('Update returned no row');
      await tx.update(loyaltyProgramProgress).set({ frozenAt: null, updatedAt: now }).where(eq(loyaltyProgramProgress.programId, target.id));
      await this.recordEvent(tx, activated, {
        eventType: previous ? 'switched_to' : 'activated',
        fromStatus: target.status,
        toStatus: 'active',
        version: activated.currentVersion,
        actorUserId,
        metadata: previous ? { replaced: previous.id } : {},
      });
      await tx
        .insert(loyaltyProgramSetup)
        .values({ businessId, state: 'configured' })
        .onConflictDoUpdate({ target: loyaltyProgramSetup.businessId, set: { state: 'configured', updatedAt: now } });
      return { activated: { ...activated, config }, previous };
    });
  }

  /** Pauses the active programme (Owner only): the business then earns nothing until another is activated. History and balances remain. */
  async deactivate(businessId: string, actorUserId: string, programId: string): Promise<ProgrammeView> {
    return this.db.transaction(async (tx) => {
      await this.lockBusiness(tx, businessId);
      await this.requireOwner(tx, actorUserId, businessId);
      const program = await this.lockProgram(tx, businessId, programId);
      if (program.status !== 'active') throw new AppError('Only the active programme can be paused.', 409, 'PROGRAM_NOT_ACTIVE');
      const now = new Date();
      const [updated] = await tx.update(loyaltyPrograms).set({ status: 'inactive', deactivatedAt: now, updatedAt: now }).where(eq(loyaltyPrograms.id, program.id)).returning();
      if (!updated) throw new Error('Update returned no row');
      await tx.update(loyaltyProgramProgress).set({ frozenAt: now, updatedAt: now }).where(and(eq(loyaltyProgramProgress.programId, program.id), sql`${loyaltyProgramProgress.frozenAt} IS NULL`));
      await this.recordEvent(tx, updated, { eventType: 'deactivated', fromStatus: 'active', toStatus: 'inactive', version: updated.currentVersion, actorUserId });
      return { ...updated, config: await this.currentConfig(tx, updated) };
    });
  }

  /** Retires a programme for good (never reused). The active programme must be paused first. */
  async retire(businessId: string, actorUserId: string, programId: string): Promise<ProgrammeView> {
    return this.db.transaction(async (tx) => {
      await this.lockBusiness(tx, businessId);
      await this.requireOwner(tx, actorUserId, businessId);
      const program = await this.lockProgram(tx, businessId, programId);
      if (program.status === 'active') throw new AppError('Pause the active programme before retiring it.', 409, 'PROGRAM_STILL_ACTIVE');
      if (program.status === 'retired') throw new AppError('The programme is already retired.', 409, 'PROGRAM_NOT_RETIRABLE');
      const now = new Date();
      const [updated] = await tx.update(loyaltyPrograms).set({ status: 'retired', retiredAt: now, updatedAt: now }).where(eq(loyaltyPrograms.id, program.id)).returning();
      if (!updated) throw new Error('Update returned no row');
      await this.recordEvent(tx, updated, { eventType: 'retired', fromStatus: program.status, toStatus: 'retired', version: updated.currentVersion, actorUserId });
      return { ...updated, config: await this.currentConfig(tx, updated) };
    });
  }

  /**
   * Keeps a LEGACY programme in step with the existing loyalty settings screen: an existing business that edits its points-per-currency-unit
   * or check-in points keeps working exactly as before, as a new version of its legacy LP-03 programme (future events only). A business on
   * any other programme is not affected by those two settings.
   */
  async syncLegacySettings(
    businessId: string,
    actorUserId: string,
    settings: { pointsPerCurrencyUnit: string; pointsPerCheckin: number },
  ): Promise<boolean> {
    const [active] = await this.db
      .select({ id: loyaltyPrograms.id, legacy: loyaltyPrograms.legacy, type: loyaltyPrograms.type })
      .from(loyaltyPrograms)
      .where(and(eq(loyaltyPrograms.businessId, businessId), eq(loyaltyPrograms.status, 'active')))
      .limit(1);
    if (!active || !active.legacy || active.type !== 'LP-03') return false;
    await this.saveConfig(businessId, actorUserId, active.id, {
      pointsPerCurrencyUnit: settings.pointsPerCurrencyUnit,
      pointsPerCheckin: settings.pointsPerCheckin,
      rounding: 'floor',
      legacy: true,
    });
    return true;
  }

  /** Validates a configuration for the preview screen without storing anything. */
  async checkConfig(businessId: string, type: string, config: unknown): Promise<{ config: Record<string, unknown>; currency: string }> {
    const currency = await this.currencyOf(this.db, businessId);
    const checked = this.requireValidConfig(type, config, currency);
    await this.requireValidReferences(this.db, businessId, type, checked);
    return { config: checked, currency };
  }

  /** Records that a new business chose Configure Later: it can join and be served, but earns nothing until a programme is active. */
  async markConfigureLater(businessId: string): Promise<void> {
    await this.db
      .insert(loyaltyProgramSetup)
      .values({ businessId, state: 'pending' })
      .onConflictDoNothing({ target: loyaltyProgramSetup.businessId });
  }

  async setupState(businessId: string): Promise<'legacy' | 'pending' | 'configured'> {
    const [row] = await this.db.select({ state: loyaltyProgramSetup.state }).from(loyaltyProgramSetup).where(eq(loyaltyProgramSetup.businessId, businessId)).limit(1);
    if (row) return row.state as 'pending' | 'configured';
    const [any] = await this.db.select({ id: loyaltyPrograms.id }).from(loyaltyPrograms).where(eq(loyaltyPrograms.businessId, businessId)).limit(1);
    return any ? 'configured' : 'legacy';
  }

  // ---- internals ---------------------------------------------------------------------------------------------------------------------

  /** Serialises every programme change for one business, so concurrent activations never interleave. The partial unique index is the backstop. */
  private async lockBusiness(tx: Tx, businessId: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'loyalty-programme:' + businessId}, 0))`);
  }

  private async lockProgram(tx: Tx, businessId: string, programId: string): Promise<LoyaltyProgramRow> {
    const [program] = await tx
      .select()
      .from(loyaltyPrograms)
      .where(and(eq(loyaltyPrograms.id, programId), eq(loyaltyPrograms.businessId, businessId)))
      .for('update');
    if (!program) throw new AppError('Programme not found.', 404, 'PROGRAM_NOT_FOUND');
    return program;
  }

  private async currencyOf(tx: Executor, businessId: string): Promise<string> {
    const [business] = await tx.select({ currency: businesses.defaultCurrency }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!business) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    return business.currency;
  }

  private async currentConfig(tx: Executor, program: LoyaltyProgramRow): Promise<Record<string, unknown>> {
    const [row] = await tx
      .select({ config: loyaltyProgramVersions.config })
      .from(loyaltyProgramVersions)
      .where(and(eq(loyaltyProgramVersions.programId, program.id), eq(loyaltyProgramVersions.version, program.currentVersion)))
      .limit(1);
    if (!row) throw new AppError('The programme has no configuration.', 409, 'PROGRAM_NO_CONFIGURATION');
    return row.config;
  }

  private requireValidConfig(type: string, config: unknown, currency: string): Record<string, unknown> {
    const result = validateProgramConfig(type, config, { currency });
    if (!result.ok) throw new ProgramConfigError(result.errors);
    return result.config;
  }

  /** Checks what a configuration points at: an LP-01 card must entitle the customer to an ACTIVE free-item reward of THIS business. */
  private async requireValidReferences(tx: Executor, businessId: string, type: string, config: Record<string, unknown>): Promise<void> {
    if (type !== 'LP-01') return;
    const [reward] = await tx
      .select({ type: loyaltyRewards.type, status: loyaltyRewards.status })
      .from(loyaltyRewards)
      .where(and(eq(loyaltyRewards.id, String(config.rewardId)), eq(loyaltyRewards.businessId, businessId), eq(loyaltyRewards.isDeleted, false)))
      .limit(1);
    if (!reward || reward.status !== 'active' || reward.type !== 'free_item') {
      throw new ProgramConfigError([
        { path: 'rewardId', code: 'REWARD_NOT_FOUND', message: 'Choose an active free-item reward from this business\'s reward catalogue.' },
      ]);
    }
  }

  private async insertVersion(tx: Tx, program: LoyaltyProgramRow, version: number, config: Record<string, unknown>, actorUserId: string) {
    await tx.insert(loyaltyProgramVersions).values({
      programId: program.id,
      businessId: program.businessId,
      version,
      config,
      configHash: sql`encode(sha256(convert_to(${JSON.stringify(config)}::jsonb::text, 'UTF8')), 'hex')` as unknown as string,
      createdBy: actorUserId,
    });
  }

  private async recordEvent(
    tx: Tx,
    program: LoyaltyProgramRow,
    event: { eventType: (typeof loyaltyProgramEvents.$inferInsert)['eventType']; fromStatus?: string; toStatus?: string; version?: number; actorUserId: string; metadata?: Record<string, unknown> },
  ) {
    await tx.insert(loyaltyProgramEvents).values({
      businessId: program.businessId,
      programId: program.id,
      eventType: event.eventType,
      fromStatus: event.fromStatus ?? null,
      toStatus: event.toStatus ?? null,
      version: event.version ?? null,
      actorUserId: event.actorUserId,
      metadata: event.metadata ?? {},
    });
  }

  /** Only the business Owner (the system Owner role, business-wide) may activate, pause, switch or retire the primary programme. */
  private async requireOwner(tx: Tx, userId: string, businessId: string): Promise<void> {
    const [grant] = await tx
      .select({ id: userBusinessRoles.id })
      .from(userBusinessRoles)
      .innerJoin(roles, eq(roles.id, userBusinessRoles.roleId))
      .where(
        and(
          eq(userBusinessRoles.userId, userId),
          eq(userBusinessRoles.businessId, businessId),
          sql`${userBusinessRoles.branchId} IS NULL`,
          eq(roles.name, OWNER_ROLE_NAME),
          eq(roles.isSystem, true),
        ),
      )
      .limit(1);
    if (!grant) throw new AppError('Only the business Owner can activate or switch the loyalty programme.', 403, 'PROGRAM_OWNER_REQUIRED');
  }
}

export class ProgramConfigError extends AppError {
  constructor(readonly issues: readonly ProgramConfigIssue[]) {
    super('The programme configuration is not valid.', 422, 'PROGRAM_CONFIG_INVALID', issues);
  }
}
