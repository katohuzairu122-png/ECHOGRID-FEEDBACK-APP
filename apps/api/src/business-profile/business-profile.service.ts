import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  businessProfileRevisionLocations, businessProfileRevisions, businessProfileRevisionTranslations,
  businessPublicProfiles,
} from '../db/schema/business-profiles';
import { businesses } from '../db/schema/businesses';
import { auditLog } from '../db/schema/audit-log';
import { AppError } from '../lib/errors';
import {
  validateProfileContent, type NormalizedProfileContent, type ProfileContentInput, type ProfileFieldError,
} from './profile-content';
import { computeProfileDigest } from './profile-digest';
import { newProfileHandle } from './profile-handle';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type ProfileRow = typeof businessPublicProfiles.$inferSelect;
type RevisionRow = typeof businessProfileRevisions.$inferSelect;

/**
 * Moderation reason codes. PENDING owner decision D-16 (the interim content policy is still an unapproved draft):
 * this list is a code-owned constant taken from `BDPN_01B_VALIDATION_AND_MODERATION_DESIGN.md` section 7, so the owner
 * can change it without a schema change. The database only constrains the FORMAT (`^[A-Z_]{3,40}$`).
 */
export const PROFILE_REASON_CODES = [
  'MISLEADING_CLAIM', 'IMPERSONATION', 'PROHIBITED_BUSINESS', 'PERSONAL_DATA', 'CONTACT_ABUSE', 'OFFERS_AND_PRICING',
  'HARMFUL_OR_UNLAWFUL', 'OFF_TOPIC_OR_LOW_QUALITY', 'INCOMPLETE', 'LANGUAGE_MISMATCH', 'OTHER',
] as const;
export type ProfileReasonCode = (typeof PROFILE_REASON_CODES)[number];
export const isProfileReasonCode = (value: unknown): value is ProfileReasonCode =>
  typeof value === 'string' && (PROFILE_REASON_CODES as readonly string[]).includes(value);

export type ProfileActor = {
  userId: string;
  /** `business` for business routes, `platform_admin` for moderation. Recorded in the audit row, never trusted for access. */
  role: 'business' | 'platform_admin';
  ipAddress?: string | null;
  userAgent?: string | null;
};

const notFound = () => new AppError('Not found.', 404, 'PROFILE_NOT_FOUND');
const stateConflict = (message = 'The profile is not in a state that allows this change.') =>
  new AppError(message, 409, 'PROFILE_STATE_CONFLICT');
const versionConflict = () => new AppError('The profile changed since you loaded it.', 409, 'PROFILE_VERSION_CONFLICT');
const validationFailed = (errors: ProfileFieldError[]) =>
  new AppError('The profile content is not valid.', 422, 'PROFILE_VALIDATION_FAILED', { details: errors });

const dbCode = (error: unknown): string | undefined => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
};

/**
 * One transaction per operation. A guard or constraint refusal from the database (the same rules enforced a second time
 * by the 0080 triggers) is reported as a state conflict instead of leaking a driver error.
 */
async function run<T>(db: Database, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(work);
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = dbCode(error);
    if (code === '23000' || code === '23505' || code === '23514') throw stateConflict();
    throw error;
  }
}

export type ProfileResult = { businessId: string; version: number; publicationState: ProfileRow['publicationState']; revisionId?: string; revisionNo?: number };

/**
 * BDPN-01B part 3: the single owner of every business-profile state change (design section 5). Business routes and
 * platform routes are thin callers that have ALREADY authorized the actor (business-wide `profile:edit` and
 * `profile:submit`, or the code-owned platform `profile:moderate`); this layer enforces tenancy by always taking the
 * business id from the caller's own context, the optimistic version, the digest binding, and separation of duties. The
 * same legal-transition and immutability rules are enforced again by the database (migration 0080).
 *
 * Not here (later blocks): idempotency keys (they need their own table), the moderator review bundle and queue reads,
 * routes, notifications. Nothing calls this service yet.
 */
export class BusinessProfileService {
  constructor(private readonly db: Database) {}

  // ---- business operations -------------------------------------------------------------------------------------

  /** Creates the publication record lazily, then edits the open draft (or opens revision n+1). */
  async saveDraft(businessId: string, actor: ProfileActor, input: ProfileContentInput, options: { expectedVersion?: number } = {}): Promise<ProfileResult> {
    const result = validateProfileContent(input);
    if (!result.ok) throw validationFailed(result.errors);
    const content = result.content;
    return run(this.db, async (tx) => {
      await this.requireActiveBusiness(tx, businessId);
      const profile = await this.lockOrCreateProfile(tx, businessId, actor.userId);
      this.checkVersion(profile, options.expectedVersion);
      let [draft] = await tx.select().from(businessProfileRevisions)
        .where(and(eq(businessProfileRevisions.businessId, businessId), eq(businessProfileRevisions.status, 'draft'))).for('update');
      if (!draft) {
        const [latest] = await tx.select({ n: businessProfileRevisions.revisionNo }).from(businessProfileRevisions)
          .where(eq(businessProfileRevisions.businessId, businessId)).orderBy(desc(businessProfileRevisions.revisionNo)).limit(1);
        [draft] = await tx.insert(businessProfileRevisions).values({
          businessId, revisionNo: (latest?.n ?? 0) + 1, websiteUrl: content.websiteUrl, createdBy: actor.userId, updatedBy: actor.userId,
        }).returning();
      } else {
        await tx.update(businessProfileRevisions).set({ websiteUrl: content.websiteUrl, updatedAt: new Date(), updatedBy: actor.userId })
          .where(eq(businessProfileRevisions.id, draft.id));
      }
      await this.replaceContent(tx, draft!.id, businessId, content);
      const version = await this.bump(tx, profile, actor.userId);
      await this.audit(tx, actor, businessId, 'draft_saved', draft!.id, { revisionId: draft!.id, revisionNo: draft!.revisionNo });
      return { businessId, version, publicationState: profile.publicationState, revisionId: draft!.id, revisionNo: draft!.revisionNo };
    });
  }

  /** Submission completeness (D-04) then digest; the revision becomes immutable. */
  async submit(businessId: string, actor: ProfileActor, revisionId: string, options: { expectedVersion?: number } = {}): Promise<ProfileResult & { digest: string }> {
    return run(this.db, async (tx) => {
      const business = await this.requireActiveBusiness(tx, businessId);
      const profile = await this.lockProfile(tx, businessId);
      if (!profile) throw notFound();
      this.checkVersion(profile, options.expectedVersion);
      const revision = await this.lockRevision(tx, revisionId, businessId);
      if (revision.status !== 'draft') throw stateConflict('Only a draft can be submitted.');
      const [pending] = await tx.select({ id: businessProfileRevisions.id }).from(businessProfileRevisions)
        .where(and(eq(businessProfileRevisions.businessId, businessId), eq(businessProfileRevisions.status, 'submitted')));
      if (pending) throw stateConflict('Another revision is already awaiting review.');
      const stored = await this.loadContent(tx, revision);
      const missing: ProfileFieldError[] = [];
      if (business.categoryId === null) missing.push({ field: 'category', rule: 'required' });
      const checked = validateProfileContent(stored.input, { requireComplete: true, defaultLocale: business.defaultLocale });
      if (!checked.ok) missing.push(...checked.errors);
      if (!checked.ok || missing.length > 0) throw validationFailed(missing);
      const digest = await computeProfileDigest(checked.content);
      await tx.update(businessProfileRevisions).set({
        status: 'submitted', contentDigest: digest, submittedBy: actor.userId, submittedAt: new Date(), updatedAt: new Date(), updatedBy: actor.userId,
      }).where(eq(businessProfileRevisions.id, revision.id));
      const version = await this.bump(tx, profile, actor.userId);
      await this.audit(tx, actor, businessId, 'submitted', revision.id, { revisionId: revision.id, revisionNo: revision.revisionNo, digest });
      return { businessId, version, publicationState: profile.publicationState, revisionId: revision.id, revisionNo: revision.revisionNo, digest };
    });
  }

  async withdraw(businessId: string, actor: ProfileActor, options: { expectedVersion?: number } = {}): Promise<ProfileResult> {
    return run(this.db, async (tx) => {
      await this.requireActiveBusiness(tx, businessId);
      const profile = await this.lockProfile(tx, businessId);
      if (!profile) throw notFound();
      this.checkVersion(profile, options.expectedVersion);
      if (profile.publicationState !== 'published') throw stateConflict('Only a published profile can be withdrawn.');
      const version = profile.version + 1;
      await tx.update(businessPublicProfiles).set({ publicationState: 'withdrawn', withdrawnAt: new Date(), version, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(businessPublicProfiles.businessId, businessId));
      await this.audit(tx, actor, businessId, 'withdrawn', profile.publishedRevisionId ?? businessId, { revisionId: profile.publishedRevisionId });
      return { businessId, version, publicationState: 'withdrawn' };
    });
  }

  /** D-13: live again without a new review, only if the kept revision is still approved and the business is still eligible. */
  async republish(businessId: string, actor: ProfileActor, options: { expectedVersion?: number } = {}): Promise<ProfileResult> {
    return run(this.db, async (tx) => {
      const business = await this.requireActiveBusiness(tx, businessId);
      const profile = await this.lockProfile(tx, businessId);
      if (!profile) throw notFound();
      this.checkVersion(profile, options.expectedVersion);
      if (profile.publicationState !== 'withdrawn' || !profile.publishedRevisionId) throw stateConflict('Only a withdrawn profile can be re-published.');
      const [kept] = await tx.select().from(businessProfileRevisions).where(eq(businessProfileRevisions.id, profile.publishedRevisionId)).for('update');
      if (!kept || kept.status !== 'approved') throw stateConflict('The approved revision is no longer current; submit a new revision.');
      const [name] = await tx.select({ id: businessProfileRevisionTranslations.revisionId }).from(businessProfileRevisionTranslations)
        .where(and(eq(businessProfileRevisionTranslations.revisionId, kept.id), eq(businessProfileRevisionTranslations.locale, business.defaultLocale)));
      if (!name) throw stateConflict('The profile is not eligible: no default-locale text.');
      const version = profile.version + 1;
      await tx.update(businessPublicProfiles).set({ publicationState: 'published', publishedAt: new Date(), version, updatedAt: new Date(), updatedBy: actor.userId })
        .where(eq(businessPublicProfiles.businessId, businessId));
      await this.audit(tx, actor, businessId, 'republished', kept.id, { revisionId: kept.id });
      return { businessId, version, publicationState: 'published', revisionId: kept.id, revisionNo: kept.revisionNo };
    });
  }

  // ---- platform moderation ---------------------------------------------------------------------------------------

  /**
   * Approves a submitted revision. The caller sends the digest the moderator reviewed; it must equal both the stored
   * digest and a digest recomputed from the stored rows (threat T-04), and the reviewer must not be the submitter.
   */
  async approve(revisionId: string, reviewer: ProfileActor, reviewedDigest: string, options: { expectedVersion?: number } = {}): Promise<ProfileResult> {
    return run(this.db, async (tx) => {
      const [located] = await tx.select({ businessId: businessProfileRevisions.businessId }).from(businessProfileRevisions)
        .where(eq(businessProfileRevisions.id, revisionId));
      if (!located) throw notFound();
      const businessId = located.businessId;
      await this.requireActiveBusiness(tx, businessId);
      const profile = await this.lockProfile(tx, businessId);
      if (!profile) throw notFound();
      this.checkVersion(profile, options.expectedVersion);
      const revision = await this.lockRevision(tx, revisionId, businessId);
      if (revision.status !== 'submitted') throw stateConflict('Only a submitted revision can be approved.');
      if (revision.submittedBy === reviewer.userId) throw new AppError('A reviewer cannot approve their own submission.', 409, 'PROFILE_SELF_REVIEW_DENIED');
      if (profile.publicationState === 'suspended') throw stateConflict('The profile is suspended; lift the suspension first.');
      const stored = await this.loadContent(tx, revision);
      const recomputed = validateProfileContent(stored.input);
      const digest = recomputed.ok ? await computeProfileDigest(recomputed.content) : null;
      if (digest === null || digest !== revision.contentDigest || reviewedDigest !== revision.contentDigest) {
        throw new AppError('The content changed since it was reviewed.', 409, 'PROFILE_DIGEST_MISMATCH');
      }
      const previousId = profile.publishedRevisionId;
      await tx.update(businessProfileRevisions).set({
        status: 'approved', reviewedBy: reviewer.userId, reviewedAt: new Date(), updatedAt: new Date(), updatedBy: reviewer.userId,
      }).where(eq(businessProfileRevisions.id, revision.id));
      if (previousId && previousId !== revision.id) {
        await tx.update(businessProfileRevisions).set({ status: 'superseded', updatedAt: new Date(), updatedBy: reviewer.userId })
          .where(and(eq(businessProfileRevisions.id, previousId), eq(businessProfileRevisions.status, 'approved')));
      }
      const version = profile.version + 1;
      await tx.update(businessPublicProfiles).set({
        publicationState: 'published', publishedRevisionId: revision.id, publishedAt: new Date(), version, updatedAt: new Date(), updatedBy: reviewer.userId,
      }).where(eq(businessPublicProfiles.businessId, businessId));
      await this.audit(tx, reviewer, businessId, profile.publicationState === 'published' ? 'updated' : 'published', revision.id, {
        revisionId: revision.id, revisionNo: revision.revisionNo, digest: revision.contentDigest, previousRevisionId: previousId,
      });
      await this.audit(tx, reviewer, businessId, 'approved', revision.id, { revisionId: revision.id, digest: revision.contentDigest });
      return { businessId, version, publicationState: 'published', revisionId: revision.id, revisionNo: revision.revisionNo };
    });
  }

  async reject(revisionId: string, reviewer: ProfileActor, reasonCode: string, internalNote?: string | null): Promise<ProfileResult> {
    if (!isProfileReasonCode(reasonCode)) throw validationFailed([{ field: 'reason_code', rule: 'invalid' }]);
    const note = internalNote === undefined || internalNote === null || internalNote.trim() === '' ? null : internalNote.trim();
    if (note !== null && [...note].length > 500) throw validationFailed([{ field: 'internal_note', rule: 'length' }]);
    return run(this.db, async (tx) => {
      const [located] = await tx.select({ businessId: businessProfileRevisions.businessId }).from(businessProfileRevisions)
        .where(eq(businessProfileRevisions.id, revisionId));
      if (!located) throw notFound();
      const businessId = located.businessId;
      const profile = await this.lockProfile(tx, businessId);
      if (!profile) throw notFound();
      const revision = await this.lockRevision(tx, revisionId, businessId);
      if (revision.status !== 'submitted') throw stateConflict('Only a submitted revision can be rejected.');
      if (revision.submittedBy === reviewer.userId) throw new AppError('A reviewer cannot reject their own submission.', 409, 'PROFILE_SELF_REVIEW_DENIED');
      await tx.update(businessProfileRevisions).set({
        status: 'rejected', reviewedBy: reviewer.userId, reviewedAt: new Date(), reviewReasonCode: reasonCode, reviewNoteInternal: note,
        updatedAt: new Date(), updatedBy: reviewer.userId,
      }).where(eq(businessProfileRevisions.id, revision.id));
      // A rejection changes no publication state and no live pointer, so the publication version is not bumped.
      await this.audit(tx, reviewer, businessId, 'rejected', revision.id, { revisionId: revision.id, reasonCode });
      return { businessId, version: profile.version, publicationState: profile.publicationState, revisionId: revision.id, revisionNo: revision.revisionNo };
    });
  }

  async suspend(businessId: string, reviewer: ProfileActor, reasonCode: string, internalNote?: string | null): Promise<ProfileResult> {
    if (!isProfileReasonCode(reasonCode)) throw validationFailed([{ field: 'reason_code', rule: 'invalid' }]);
    const hasNote = internalNote !== undefined && internalNote !== null && internalNote.trim() !== '';
    return run(this.db, async (tx) => {
      const profile = await this.lockProfile(tx, businessId);
      if (!profile) throw notFound();
      if (profile.publicationState === 'suspended') throw stateConflict('The profile is already suspended.');
      const version = profile.version + 1;
      await tx.update(businessPublicProfiles).set({
        publicationState: 'suspended', suspendedAt: new Date(), suspendedBy: reviewer.userId, suspensionReasonCode: reasonCode,
        version, updatedAt: new Date(), updatedBy: reviewer.userId,
      }).where(eq(businessPublicProfiles.businessId, businessId));
      await this.audit(tx, reviewer, businessId, 'suspended', businessId, { reasonCode, hadInternalNote: hasNote });
      return { businessId, version, publicationState: 'suspended' };
    });
  }

  /** Lifting is NOT an automatic re-publish: the profile returns to `unpublished` with its pointer kept. */
  async liftSuspension(businessId: string, reviewer: ProfileActor): Promise<ProfileResult> {
    return run(this.db, async (tx) => {
      const profile = await this.lockProfile(tx, businessId);
      if (!profile) throw notFound();
      if (profile.publicationState !== 'suspended') throw stateConflict('The profile is not suspended.');
      const version = profile.version + 1;
      await tx.update(businessPublicProfiles).set({
        publicationState: 'unpublished', suspendedAt: null, suspendedBy: null, suspensionReasonCode: null,
        version, updatedAt: new Date(), updatedBy: reviewer.userId,
      }).where(eq(businessPublicProfiles.businessId, businessId));
      await this.audit(tx, reviewer, businessId, 'suspension_lifted', businessId, {});
      return { businessId, version, publicationState: 'unpublished' };
    });
  }

  // ---- helpers -------------------------------------------------------------------------------------------------------

  private checkVersion(profile: ProfileRow, expected?: number) {
    if (expected !== undefined && expected !== profile.version) throw versionConflict();
  }

  /** The business must exist, be active and not soft-deleted; the caller's tenant is the only business ever touched. */
  private async requireActiveBusiness(tx: Tx, businessId: string) {
    const [business] = await tx.select({ id: businesses.id, status: businesses.status, isDeleted: businesses.isDeleted, defaultLocale: businesses.defaultLocale, categoryId: businesses.categoryId })
      .from(businesses).where(eq(businesses.id, businessId));
    if (!business) throw notFound();
    if (business.status !== 'active' || business.isDeleted) throw stateConflict('The business is not active.');
    return business;
  }

  private async lockProfile(tx: Tx, businessId: string): Promise<ProfileRow | null> {
    const [row] = await tx.select().from(businessPublicProfiles).where(eq(businessPublicProfiles.businessId, businessId)).for('update');
    return row ?? null;
  }

  /** Lazy creation (registration creates nothing). A handle collision is retried inside a savepoint. */
  private async lockOrCreateProfile(tx: Tx, businessId: string, userId: string): Promise<ProfileRow> {
    const existing = await this.lockProfile(tx, businessId);
    if (existing) return existing;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await tx.transaction(async (savepoint) => {
          await savepoint.insert(businessPublicProfiles).values({ businessId, profileHandle: newProfileHandle(), createdBy: userId, updatedBy: userId })
            .onConflictDoNothing({ target: businessPublicProfiles.businessId });
        });
        break;
      } catch (error) {
        if (dbCode(error) === '23505' && attempt < 3) continue;
        throw error;
      }
    }
    const created = await this.lockProfile(tx, businessId);
    if (!created) throw stateConflict();
    return created;
  }

  private async lockRevision(tx: Tx, revisionId: string, businessId: string): Promise<RevisionRow> {
    const [revision] = await tx.select().from(businessProfileRevisions)
      .where(and(eq(businessProfileRevisions.id, revisionId), eq(businessProfileRevisions.businessId, businessId))).for('update');
    if (!revision) throw notFound();
    return revision;
  }

  private async bump(tx: Tx, profile: ProfileRow, userId: string): Promise<number> {
    const version = profile.version + 1;
    await tx.update(businessPublicProfiles).set({ version, updatedAt: new Date(), updatedBy: userId }).where(eq(businessPublicProfiles.businessId, profile.businessId));
    return version;
  }

  private async replaceContent(tx: Tx, revisionId: string, businessId: string, content: NormalizedProfileContent) {
    await tx.delete(businessProfileRevisionTranslations).where(eq(businessProfileRevisionTranslations.revisionId, revisionId));
    await tx.delete(businessProfileRevisionLocations).where(eq(businessProfileRevisionLocations.revisionId, revisionId));
    if (content.translations.length > 0) {
      await tx.insert(businessProfileRevisionTranslations).values(content.translations.map((t) => ({
        revisionId, businessId, locale: t.locale, displayName: t.displayName, summary: t.summary, description: t.description,
      })));
    }
    if (content.locations.length > 0) {
      await tx.insert(businessProfileRevisionLocations).values(content.locations.map((l) => ({
        revisionId, businessId, position: l.position, kind: l.kind, label: l.label, countryCode: l.countryCode, city: l.city, region: l.region, streetAddress: l.streetAddress,
      })));
    }
  }

  /** Rebuilds the validator input from the stored rows (a stored street address implies the opt-in was given at save time). */
  private async loadContent(tx: Tx, revision: RevisionRow): Promise<{ input: ProfileContentInput }> {
    const translations = await tx.select().from(businessProfileRevisionTranslations).where(eq(businessProfileRevisionTranslations.revisionId, revision.id));
    const locations = await tx.select().from(businessProfileRevisionLocations)
      .where(eq(businessProfileRevisionLocations.revisionId, revision.id)).orderBy(asc(businessProfileRevisionLocations.position));
    return {
      input: {
        websiteUrl: revision.websiteUrl,
        translations: translations.map((t) => ({ locale: t.locale, displayName: t.displayName, summary: t.summary, description: t.description })),
        locations: locations.map((l) => ({ kind: l.kind, label: l.label, countryCode: l.countryCode, city: l.city, region: l.region, streetAddress: l.streetAddress })),
        streetAddressOptIn: locations.some((l) => l.streetAddress !== null),
      },
    };
  }

  /** One audit row per operation, in the same transaction (a failed audit write rolls the operation back). No profile text, no internal note. */
  private async audit(tx: Tx, actor: ProfileActor, businessId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
    await tx.insert(auditLog).values({
      businessId, actorUserId: actor.userId, action: `business_profile.${action}`, entityType: 'business_profile', entityId,
      metadata: { ...metadata, actorRole: actor.role }, ipAddress: actor.ipAddress ?? null, userAgent: actor.userAgent ?? null,
    });
  }
}
