import 'server-only';
import { ApiError, apiFetch } from './api-client';

/**
 * BCOMM-03: the business's own Community posts, read from the API. The server owns every rule (permission, tenancy, moderation state); this
 * parser accepts only the documented shape and treats anything else as unavailable. A 403 means the user may see the Community hub but not
 * manage posts, and is shown as such rather than as an error.
 */
export const POST_STAGES = ['draft', 'awaiting_review', 'rejected', 'live', 'suspended', 'archived'] as const;
export type PostStage = (typeof POST_STAGES)[number];

export interface BusinessPost {
  handle: string;
  stage: PostStage;
  latestRevisionNo: number;
  reasonCode: string | null;
  body: string;
  linkUrl: string | null;
  contentLocale: string;
  publishedAt: string | null;
  createdAt: string;
}

export type BusinessPosts = { state: 'ready'; posts: BusinessPost[] } | { state: 'forbidden' } | { state: 'unavailable' };

const HANDLE = /^[A-Za-z0-9_-]{22}$/;
const str = (v: unknown): v is string => typeof v === 'string';

export function parseBusinessPost(value: unknown): BusinessPost | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!str(v.handle) || !HANDLE.test(v.handle)) return null;
  if (!str(v.stage) || !(POST_STAGES as readonly string[]).includes(v.stage)) return null;
  if (!str(v.body) || !str(v.contentLocale) || !str(v.createdAt)) return null;
  if (typeof v.latestRevisionNo !== 'number' || !Number.isInteger(v.latestRevisionNo) || v.latestRevisionNo < 1) return null;
  if (v.linkUrl !== null && !str(v.linkUrl)) return null;
  if (v.reasonCode !== null && !str(v.reasonCode)) return null;
  if (v.publishedAt !== null && !str(v.publishedAt)) return null;
  return {
    handle: v.handle, stage: v.stage as PostStage, latestRevisionNo: v.latestRevisionNo, reasonCode: v.reasonCode as string | null,
    body: v.body, linkUrl: v.linkUrl as string | null, contentLocale: v.contentLocale, publishedAt: v.publishedAt as string | null, createdAt: v.createdAt,
  };
}

export function parseBusinessPosts(value: unknown): BusinessPosts {
  if (!Array.isArray(value)) return { state: 'unavailable' };
  const posts = value.map(parseBusinessPost);
  if (posts.some((p) => p === null)) return { state: 'unavailable' };
  return { state: 'ready', posts: posts as BusinessPost[] };
}

export async function getBusinessPosts(businessId: string): Promise<BusinessPosts> {
  try {
    return parseBusinessPosts(await apiFetch<unknown>('/network/business-posts', { businessId }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return { state: 'forbidden' };
    return { state: 'unavailable' };
  }
}
