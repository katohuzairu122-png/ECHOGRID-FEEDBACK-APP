import type { CurrentUserDto } from '@echo-grid-feedback/shared-types';

export const moderationPath = '/platform/network-moderation';

export const locales = ['en', 'fr', 'es', 'ar'] as const;
export const reasons = [
  'hate_or_harassment',
  'threats',
  'sexual_content',
  'illegal_goods_services',
  'fraud_or_scam',
  'impersonation',
  'personal_data',
  'misleading_claim',
  'competitor_disparagement',
  'unsafe_link',
  'spam_or_duplicate',
] as const;
export const postOperations = ['suspend', 'lift', 'withdraw', 'pin', 'unpin'] as const;

export function canModerate(user: Pick<CurrentUserDto, 'platformRole' | 'impersonatedBy'> | null) {
  return user?.platformRole === 'admin' && user.impersonatedBy === null;
}

export interface PendingRevision {
  revisionId: string;
  postHandle: string;
  revisionNo: number;
  body: string;
  linkUrl: string | null;
  contentLocale: string;
  submittedAt: string | null;
  approvals: number;
}

export interface PostState {
  handle: string;
  state: 'unpublished' | 'published' | 'suspended' | 'withdrawn';
  pinned: boolean;
  expiresAt: string | null;
}

export interface ModerationResult {
  error?: string;
  notice?: string;
  handle?: string;
  post?: PostState;
}
