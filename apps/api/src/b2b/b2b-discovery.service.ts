import { and, asc, desc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  b2bParticipations,
  b2bPartnerships,
  businessCategories,
  businessProfileRevisionLocations,
  businessProfileRevisionTranslations,
  businessProfileRevisions,
  businessPublicProfiles,
  businesses,
} from '../db/schema';
import { AppError } from '../lib/errors';

export class B2bDiscoveryService {
  constructor(private readonly db: Database) {}

  async search(input: {
    businessId: string;
    query?: string;
    categoryId?: string;
    city?: string;
    region?: string;
    countryCode?: string;
    limit: number;
    offset: number;
  }) {
    const [caller] = await this.db
      .select({ id: b2bParticipations.id })
      .from(b2bParticipations)
      .innerJoin(businesses, eq(businesses.id, b2bParticipations.businessId))
      .where(
        and(
          eq(b2bParticipations.businessId, input.businessId),
          eq(b2bParticipations.status, 'active'),
          eq(businesses.status, 'active'),
          isNull(businesses.deletedAt),
        ),
      )
      .limit(1);
    if (!caller)
      throw new AppError(
        'Business network participation is required.',
        403,
        'B2B_PARTICIPATION_REQUIRED',
      );

    const predicates = [
      eq(businessPublicProfiles.publicationState, 'published'),
      eq(b2bParticipations.status, 'active'),
      eq(businesses.status, 'active'),
      isNull(businesses.deletedAt),
      sql`${businessPublicProfiles.businessId} <> ${input.businessId}`,
    ];
    if (input.query)
      predicates.push(ilike(businessProfileRevisionTranslations.displayName, `%${input.query}%`));
    if (input.categoryId) predicates.push(eq(businesses.categoryId, input.categoryId));
    if (input.city || input.region || input.countryCode) {
      predicates.push(sql`EXISTS (SELECT 1 FROM business_profile_revision_locations loc
        WHERE loc.revision_id = ${businessProfileRevisions.id} AND loc.business_id = ${businesses.id}
        AND (${input.city ?? null}::text IS NULL OR loc.city ILIKE ${input.city ? `%${input.city}%` : null})
        AND (${input.region ?? null}::text IS NULL OR loc.region ILIKE ${input.region ? `%${input.region}%` : null})
        AND (${input.countryCode ?? null}::text IS NULL OR loc.country_code = ${input.countryCode ?? null}))`);
    }

    const rows = await this.db
      .select({
        businessId: businesses.id,
        handle: businessPublicProfiles.profileHandle,
        categoryId: businesses.categoryId,
        category: businessCategories.name,
        revisionId: businessProfileRevisions.id,
        displayName: businessProfileRevisionTranslations.displayName,
        summary: businessProfileRevisionTranslations.summary,
        description: businessProfileRevisionTranslations.description,
        websiteUrl: businessProfileRevisions.websiteUrl,
        publishedAt: businessPublicProfiles.publishedAt,
        available: sql<boolean>`NOT EXISTS (SELECT 1 FROM b2b_partnerships bp WHERE bp.status IN ('active','suspended') AND ${input.businessId} IN (bp.business_a_id,bp.business_b_id) AND ${businesses.id} IN (bp.business_a_id,bp.business_b_id))
        AND NOT EXISTS (SELECT 1 FROM b2b_partnership_requests r WHERE r.status='pending' AND
          ((r.requester_business_id=${input.businessId} AND r.target_business_id=${businesses.id}) OR (r.target_business_id=${input.businessId} AND r.requester_business_id=${businesses.id})))`,
      })
      .from(businessPublicProfiles)
      .innerJoin(businesses, eq(businesses.id, businessPublicProfiles.businessId))
      .innerJoin(b2bParticipations, eq(b2bParticipations.businessId, businesses.id))
      .innerJoin(
        businessProfileRevisions,
        and(
          eq(businessProfileRevisions.id, businessPublicProfiles.publishedRevisionId),
          eq(businessProfileRevisions.businessId, businesses.id),
        ),
      )
      .innerJoin(
        businessProfileRevisionTranslations,
        and(
          eq(businessProfileRevisionTranslations.revisionId, businessProfileRevisions.id),
          eq(businessProfileRevisionTranslations.locale, 'en'),
        ),
      )
      .leftJoin(businessCategories, eq(businessCategories.id, businesses.categoryId))
      .where(and(...predicates))
      .orderBy(desc(businessPublicProfiles.publishedAt), businesses.id)
      .limit(input.limit + 1)
      .offset(input.offset);

    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const revisionIds = page.map((row) => row.revisionId);
    const locations = revisionIds.length
      ? await this.db
          .select({
            revisionId: businessProfileRevisionLocations.revisionId,
            kind: businessProfileRevisionLocations.kind,
            label: businessProfileRevisionLocations.label,
            city: businessProfileRevisionLocations.city,
            region: businessProfileRevisionLocations.region,
            countryCode: businessProfileRevisionLocations.countryCode,
          })
          .from(businessProfileRevisionLocations)
          .where(inArray(businessProfileRevisionLocations.revisionId, revisionIds))
          .orderBy(businessProfileRevisionLocations.position)
      : [];
    const byRevision = new Map<string, typeof locations>();
    for (const location of locations)
      byRevision.set(location.revisionId, [
        ...(byRevision.get(location.revisionId) ?? []),
        location,
      ]);
    const categories = await this.db
      .select({
        id: businessCategories.id,
        name: businessCategories.name,
        groupKey: businessCategories.groupKey,
      })
      .from(businessCategories)
      .where(eq(businessCategories.isActive, true))
      .orderBy(asc(businessCategories.sortOrder), asc(businessCategories.name));
    return {
      data: page.map(({ revisionId, ...profile }) => ({
        ...profile,
        locations: byRevision.get(revisionId) ?? [],
      })),
      categories,
      page: { limit: input.limit, offset: input.offset, hasMore },
    };
  }

  async profile(input: { businessId: string; handle: string }) {
    const [caller] = await this.db
      .select({ id: b2bParticipations.id })
      .from(b2bParticipations)
      .innerJoin(businesses, eq(businesses.id, b2bParticipations.businessId))
      .where(
        and(
          eq(b2bParticipations.businessId, input.businessId),
          eq(b2bParticipations.status, 'active'),
          eq(businesses.status, 'active'),
          isNull(businesses.deletedAt),
        ),
      )
      .limit(1);
    if (!caller)
      throw new AppError(
        'Business network participation is required.',
        403,
        'B2B_PARTICIPATION_REQUIRED',
      );
    const [row] = await this.db
      .select({
        businessId: businesses.id,
        handle: businessPublicProfiles.profileHandle,
        category: businessCategories.name,
        revisionId: businessProfileRevisions.id,
        displayName: businessProfileRevisionTranslations.displayName,
        summary: businessProfileRevisionTranslations.summary,
        description: businessProfileRevisionTranslations.description,
        websiteUrl: businessProfileRevisions.websiteUrl,
        publishedAt: businessPublicProfiles.publishedAt,
      })
      .from(businessPublicProfiles)
      .innerJoin(businesses, eq(businesses.id, businessPublicProfiles.businessId))
      .innerJoin(b2bParticipations, eq(b2bParticipations.businessId, businesses.id))
      .innerJoin(
        businessProfileRevisions,
        and(
          eq(businessProfileRevisions.id, businessPublicProfiles.publishedRevisionId),
          eq(businessProfileRevisions.businessId, businesses.id),
        ),
      )
      .innerJoin(
        businessProfileRevisionTranslations,
        and(
          eq(businessProfileRevisionTranslations.revisionId, businessProfileRevisions.id),
          eq(businessProfileRevisionTranslations.locale, 'en'),
        ),
      )
      .leftJoin(businessCategories, eq(businessCategories.id, businesses.categoryId))
      .where(
        and(
          eq(businessPublicProfiles.profileHandle, input.handle),
          eq(businessPublicProfiles.publicationState, 'published'),
          eq(b2bParticipations.status, 'active'),
          eq(businesses.status, 'active'),
          isNull(businesses.deletedAt),
          sql`${businesses.id} <> ${input.businessId}`,
        ),
      )
      .limit(1);
    if (!row) throw new AppError('Eligible business not found.', 404, 'B2B_NOT_FOUND');
    const locations = await this.db
      .select({
        kind: businessProfileRevisionLocations.kind,
        label: businessProfileRevisionLocations.label,
        city: businessProfileRevisionLocations.city,
        region: businessProfileRevisionLocations.region,
        countryCode: businessProfileRevisionLocations.countryCode,
      })
      .from(businessProfileRevisionLocations)
      .where(eq(businessProfileRevisionLocations.revisionId, row.revisionId))
      .orderBy(businessProfileRevisionLocations.position);
    return { ...row, locations };
  }
}
