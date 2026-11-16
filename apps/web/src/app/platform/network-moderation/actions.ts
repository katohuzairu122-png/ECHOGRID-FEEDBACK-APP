'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getCurrentUser } from '@/lib/platform';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import {
  canModerate,
  locales,
  moderationPath,
  postOperations,
  reasons,
  type ModerationResult,
  type PostState,
} from './moderation';

const validHandle = /^[A-Za-z0-9_-]{22}$/;
const validRevision = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function moderatePost(
  _previous: ModerationResult,
  form: FormData,
): Promise<ModerationResult> {
  const operation = form.get('operation');
  const target = String(form.get('target') ?? '').trim();
  let path: string;
  let method = 'POST';
  let body: string | undefined;
  let notice: string;
  try {
    if (!canModerate(await getCurrentUser()))
      return { error: 'Platform administrator access is required.' };

    if (operation === 'create' || operation === 'save') {
      const content = String(form.get('body') ?? '');
      const contentLocale = locales.find((locale) => locale === form.get('locale'));
      const linkUrl = String(form.get('link') ?? '').trim();
      if (!content.trim() || [...content.normalize('NFC').trim()].length > 2000 || !contentLocale) {
        return { error: 'Enter 1–2,000 characters of plain text and choose a language.' };
      }
      if (linkUrl && (linkUrl.length > 2048 || !linkUrl.startsWith('https://'))) {
        return { error: 'Enter an HTTPS link up to 2,048 characters.' };
      }
      if (operation === 'save' && !validHandle.test(target))
        return { error: 'Enter a valid post handle.' };
      path = operation === 'create' ? '/posts' : `/posts/${target}/draft`;
      method = operation === 'create' ? 'POST' : 'PUT';
      body = JSON.stringify({ body: content, contentLocale, linkUrl: linkUrl || null });
      notice = 'Draft saved.';
    } else if (operation === 'approve' || operation === 'reject') {
      if (!validRevision.test(target)) return { error: 'Invalid revision reference.' };
      path = `/revisions/${target}/${operation}`;
      notice = 'Revision rejected.';
    } else {
      const action = postOperations.find((item) => item === operation);
      if (operation !== 'submit' && !action) return { error: 'Choose a supported action.' };
      if (!validHandle.test(target)) return { error: 'Enter a valid post handle.' };
      if (action && form.get('confirm') !== 'on')
        return { error: 'Confirm the action for this post handle.' };
      path = `/posts/${target}/${action ?? 'submit'}`;
      notice = operation === 'submit' ? 'Draft submitted for approval.' : 'Post updated.';
    }

    if (operation === 'reject' || operation === 'suspend') {
      const reasonCode = reasons.find((reason) => reason === form.get('reason'));
      if (!reasonCode) return { error: 'Choose an approved reason.' };
      body = JSON.stringify({ reasonCode });
    }

    const response = await apiFetch<
      Partial<PostState> & {
        status?: string;
        approvals?: number;
        required?: number;
        post?: PostState;
      }
    >(moderationPath + path, { method, ...(body === undefined ? {} : { body }) });
    revalidatePath(moderationPath);
    if (operation === 'approve') {
      return response.status === 'published'
        ? { notice: 'Revision published.', ...(response.post ? { post: response.post } : {}) }
        : { notice: `Approval recorded (${response.approvals} of ${response.required}).` };
    }
    if (operation === 'create' || operation === 'save') {
      return { notice, handle: response.handle ?? target };
    }
    if (response.handle && response.state && typeof response.pinned === 'boolean') {
      return {
        notice,
        post: {
          handle: response.handle,
          state: response.state,
          pinned: response.pinned,
          expiresAt: response.expiresAt ?? null,
        },
      };
    }
    return { notice };
  } catch (error) {
    rethrowControlFlow(error);
    if (error instanceof ApiError) {
      if (error.status === 401 || error.status === 403)
        return { error: 'This session is not authorized for that action.' };
      if (error.status === 404)
        return { error: 'Moderation or the requested post is unavailable.' };
      if (error.status === 409)
        return {
          error:
            'The post changed or the action conflicts with its current state. Refresh the queue before retrying.',
        };
      if (error.status === 422 || error.status === 400) return { error: error.message };
    }
    return { error: 'The action could not be confirmed. Check the queue before retrying.' };
  }
}
