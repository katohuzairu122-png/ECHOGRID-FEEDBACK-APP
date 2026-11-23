import { z } from 'zod';
import { AppError } from '../lib/errors';

/** Inert foundation: no database adapter, route, publication or activation writer. */
const localeSchema = z.enum(['en', 'fr', 'es', 'ar']);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const artifactSchema = z.object({
  locale: localeSchema,
  content: z.string().min(1).max(100_000),
  contentHash: digestSchema,
}).strict();
const publicationSchema = z.object({
  id: z.uuid(),
  purpose: z.literal('community_membership'),
  version: z.string().min(1).max(100),
  approval: z.object({
    status: z.enum(['draft', 'approved', 'superseded']),
    reference: z.string().min(1).max(200).nullable(),
    approvedAt: timestampSchema.nullable(),
  }).strict(),
  publishedAt: timestampSchema.nullable(),
  effectiveAt: timestampSchema.nullable(),
  artifacts: z.array(artifactSchema).min(1).max(4),
  manifestHash: digestSchema,
}).strict();
const snapshotSchema = z.object({
  currentPublicationId: z.uuid(),
  publication: publicationSchema,
}).strict();

/** Trusted server persistence only; NEVER populate from a customer request.
 * A future transactional adapter must lock/revalidate the current pointer and
 * immutable publication through commit. An ordinary read is not that guarantee.
 */
export interface CommunityTermsSource {
  readCurrent(): Promise<unknown>;
}

export interface CommunityTermsView {
  readonly publicationId: string;
  readonly version: string;
  readonly effectiveAt: string;
  readonly locale: z.infer<typeof localeSchema>;
  readonly content: string;
  readonly contentHash: string;
  readonly manifestHash: string;
  readonly hashAlgorithm: 'sha256-utf8';
}

export async function hashCommunityTermsContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Fixed tuple encoding; locale order is code-point order, no text normalization.
 * This validates a future stored binding; it does not publish/approve a version.
 */
export async function hashCommunityTermsManifest(
  publication: Pick<z.infer<typeof publicationSchema>,
    'id' | 'purpose' | 'version' | 'publishedAt' | 'effectiveAt' | 'artifacts'>,
): Promise<string> {
  const artifacts = [...publication.artifacts]
    .sort((a, b) => a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0)
    .map(({ locale, contentHash }) => [locale, contentHash]);
  return hashCommunityTermsContent(JSON.stringify([
    'community-terms-manifest/1', publication.purpose, publication.id,
    publication.version, publication.publishedAt, publication.effectiveAt, artifacts,
  ]));
}

function unavailable(): never {
  throw new AppError('Community membership terms are unavailable.', 503, 'COMMUNITY_TERMS_UNAVAILABLE');
}

export class CommunityTermsAuthority {
  // No adapter is installed. The shipped default always fails closed.
  constructor(private readonly source: CommunityTermsSource = { readCurrent: async () => null }) {}

  async resolve(locale: string): Promise<Readonly<CommunityTermsView>> {
    try {
      const requestedLocale = localeSchema.parse(locale);
      // Copy/validate before the first hashing await; never expose source objects.
      const { currentPublicationId, publication } = snapshotSchema.parse(await this.source.readCurrent());
      const now = Date.now();
      if (
        publication.id !== currentPublicationId ||
        publication.approval.status !== 'approved' ||
        !publication.approval.reference || !publication.approval.approvedAt ||
        !publication.publishedAt || !publication.effectiveAt ||
        Date.parse(publication.approval.approvedAt) > now ||
        Date.parse(publication.publishedAt) > now ||
        Date.parse(publication.effectiveAt) > now ||
        Date.parse(publication.approval.approvedAt) > Date.parse(publication.publishedAt)
      ) unavailable();
      if (new Set(publication.artifacts.map((item) => item.locale)).size !== publication.artifacts.length) unavailable();
      for (const artifact of publication.artifacts) {
        if (await hashCommunityTermsContent(artifact.content) !== artifact.contentHash) unavailable();
      }
      if (await hashCommunityTermsManifest(publication) !== publication.manifestHash) unavailable();
      const artifact = publication.artifacts.find((item) => item.locale === requestedLocale);
      // No implicit fallback to unreviewed/missing legal translations.
      if (!artifact) unavailable();
      return Object.freeze({
        publicationId: publication.id, version: publication.version,
        effectiveAt: publication.effectiveAt, locale: artifact.locale,
        content: artifact.content, contentHash: artifact.contentHash,
        manifestHash: publication.manifestHash, hashAlgorithm: 'sha256-utf8' as const,
      });
    } catch {
      // Outages, missing schema, malformed records and integrity failures are
      // deliberately indistinguishable; never expose raw storage errors/metadata.
      return unavailable();
    }
  }
}

const acceptanceSchema = z.object({
  operation: z.enum(['join', 'rejoin']),
  consentAccepted: z.literal(true),
  expectedPublicationId: z.uuid(),
  expectedTermsVersion: z.string().min(1).max(100),
  expectedTermsHash: digestSchema,
  expectedArtifactHash: digestSchema,
  displayedLocale: localeSchema,
  expectedTransitionId: z.uuid().nullable(),
  idempotencyKey: z.string().min(1).max(100).refine((key) => key.trim() === key),
}).strict();

/** Pure precondition validation, NOT consent persistence or authorization.
 * Customer/phone/moderation eligibility, scoped replay and atomic evidence must
 * still be enforced under database locks by a later approved integration.
 */
export function validateCommunityTermsAcceptance(
  raw: unknown,
  terms: Readonly<CommunityTermsView>,
  basis: { operation: 'join' | 'rejoin'; transitionId: string | null },
) {
  const parsed = acceptanceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('Explicit current terms acceptance is required.', 400, 'COMMUNITY_CONSENT_REQUIRED');
  }
  const input = parsed.data;
  if (
    input.expectedPublicationId !== terms.publicationId ||
    input.expectedTermsVersion !== terms.version ||
    input.expectedTermsHash !== terms.manifestHash ||
    input.expectedArtifactHash !== terms.contentHash ||
    input.displayedLocale !== terms.locale ||
    input.expectedTransitionId !== basis.transitionId ||
    input.operation !== basis.operation
  ) {
    throw new AppError('Community terms or membership state changed. Review and retry.', 409, 'COMMUNITY_ACCEPTANCE_STALE');
  }
  return Object.freeze(input);
}
