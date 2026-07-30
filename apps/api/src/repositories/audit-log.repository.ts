import { eq, and, gte, lte } from 'drizzle-orm';
import { auditLog } from '../db/schema';
import { BaseRepository } from './base.repository';

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;

/** Shape returned by listAllWithDetails -- an entry hydrated with the
 * affected business's name and the actor's email/name, for UI that needs to
 * show something readable instead of two raw foreign keys. Both hydrated
 * fields are nullable independent of the underlying FK's nullability: a
 * business/user can be soft-deleted (or, for actorUserId, simply absent on
 * system-attributed entries) after the entry was recorded. */
export type AuditLogEntryWithDetails = AuditLogEntry & {
  businessName: string | null;
  actorEmail: string | null;
  actorFullName: string | null;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class AuditLogRepository extends BaseRepository {
  /** Callers wrap this in their own try/catch (see middleware/audit.ts) --
   * a failure here should never surface as a failure of the request it's
   * describing, since the entry is written after the real work is done. */
  async record(entry: NewAuditLogEntry): Promise<void> {
    await this.db.insert(auditLog).values(entry);
  }

  async listForBusiness(
    businessId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<AuditLogEntry[]> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return this.db.query.auditLog.findMany({
      where: eq(auditLog.businessId, businessId),
      limit,
      offset: options.offset ?? 0,
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });
  }

  async listForEntity(entityType: string, entityId: string): Promise<AuditLogEntry[]> {
    return this.db.query.auditLog.findMany({
      where: and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)),
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });
  }

  /**
   * Deliberate departure from listForBusiness's tenant-scoped convention --
   * the entire point of the Platform Admin Console's audit screen (Block 3)
   * is cross-tenant visibility for support/billing/admin roles. Every filter
   * is optional and ANDed together; passing none returns the full platform
   * log, newest first, subject only to pagination.
   */
  async listAll(
    filters: {
      businessId?: string | undefined;
      actorUserId?: string | undefined;
      entityType?: string | undefined;
      action?: string | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
    } = {},
    pagination: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<AuditLogEntry[]> {
    const limit = Math.min(pagination.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return this.db.query.auditLog.findMany({
      where: and(
        filters.businessId ? eq(auditLog.businessId, filters.businessId) : undefined,
        filters.actorUserId ? eq(auditLog.actorUserId, filters.actorUserId) : undefined,
        filters.entityType ? eq(auditLog.entityType, filters.entityType) : undefined,
        filters.action ? eq(auditLog.action, filters.action) : undefined,
        filters.from ? gte(auditLog.createdAt, filters.from) : undefined,
        filters.to ? lte(auditLog.createdAt, filters.to) : undefined,
      ),
      limit,
      offset: pagination.offset ?? 0,
      orderBy: (a, { desc }) => [desc(a.createdAt)],
    });
  }

  /**
   * Same query as listAll, hydrated via the relations in
   * db/schema/relations.ts -- backs the Platform Admin Console's audit log
   * screen (Block 6), which needs a business name and actor email to be
   * readable at all; listAll's raw foreign keys stay available for any
   * future caller (e.g. an export/report job) that has no UI reason to pay
   * the join cost. Mirrors listForBusinessWithDetails's identical
   * plain-vs-hydrated split in user-business-role.repository.ts.
   */
  async listAllWithDetails(
    filters: {
      businessId?: string | undefined;
      actorUserId?: string | undefined;
      entityType?: string | undefined;
      action?: string | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
    } = {},
    pagination: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<AuditLogEntryWithDetails[]> {
    const limit = Math.min(pagination.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const rows = await this.db.query.auditLog.findMany({
      where: and(
        filters.businessId ? eq(auditLog.businessId, filters.businessId) : undefined,
        filters.actorUserId ? eq(auditLog.actorUserId, filters.actorUserId) : undefined,
        filters.entityType ? eq(auditLog.entityType, filters.entityType) : undefined,
        filters.action ? eq(auditLog.action, filters.action) : undefined,
        filters.from ? gte(auditLog.createdAt, filters.from) : undefined,
        filters.to ? lte(auditLog.createdAt, filters.to) : undefined,
      ),
      limit,
      offset: pagination.offset ?? 0,
      orderBy: (a, { desc }) => [desc(a.createdAt)],
      with: { business: true, actor: true },
    });

    return rows.map(({ business, actor, ...entry }) => ({
      ...entry,
      businessName: business?.name ?? null,
      actorEmail: actor?.email ?? null,
      actorFullName: actor?.fullName ?? null,
    }));
  }
}
