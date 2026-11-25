'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { archivePostAction, savePostAction, submitPostAction, type PostFormState } from '@/lib/actions/business-posts';
import type { BusinessPost, PostStage } from '@/lib/business-posts';

const LOCALES = ['en', 'fr', 'es', 'ar'] as const;
const EMPTY: PostFormState = {};
const MAX = 2000;

/** Which post stages a business can still act on. The server re-checks every one of these; this only decides what to offer. */
const CAN_EDIT: readonly PostStage[] = ['draft', 'rejected', 'live'];
const CAN_SUBMIT: readonly PostStage[] = ['draft'];
const CAN_ARCHIVE: readonly PostStage[] = ['draft', 'rejected', 'awaiting_review', 'live', 'suspended'];

export function PostComposer({ editing, onDone, defaultLocale }: { editing: BusinessPost | null; onDone: () => void; defaultLocale: string }) {
  const t = useTranslations('businessCommunity.posts');
  const router = useRouter();
  const [state, action, pending] = useActionState(savePostAction, EMPTY);
  const [body, setBody] = useState(editing?.body ?? '');
  const handled = useRef<PostFormState | null>(null);
  useEffect(() => {
    if (state.ok && handled.current !== state) {
      handled.current = state;
      router.refresh();
      onDone();
    }
  }, [state, router, onDone]);
  return (
    <form action={action} className="space-y-3" aria-labelledby="post-composer-title" data-testid="post-composer">
      <h3 id="post-composer-title" className="text-sm font-semibold">{editing ? t('composer.editTitle') : t('composer.newTitle')}</h3>
      {editing ? <input type="hidden" name="handle" value={editing.handle} /> : null}
      <div className="space-y-1">
        <Label htmlFor="post-body">{t('composer.body')}</Label>
        <Textarea
          id="post-body" name="body" required maxLength={MAX} rows={5} value={body} onChange={(e) => setBody(e.target.value)}
          aria-describedby="post-body-help" aria-invalid={state.error === 'invalid' ? true : undefined}
        />
        <p id="post-body-help" className="text-xs text-neutral-600">{t('composer.bodyHelp', { max: MAX })} <span aria-live="polite">{[...body].length}/{MAX}</span></p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="post-link">{t('composer.link')}</Label>
          <Input id="post-link" name="linkUrl" type="url" inputMode="url" defaultValue={editing?.linkUrl ?? ''} placeholder="https://" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="post-locale">{t('composer.language')}</Label>
          <Select id="post-locale" name="contentLocale" defaultValue={editing?.contentLocale ?? defaultLocale}>
            {LOCALES.map((l) => <option key={l} value={l}>{t(`languages.${l}`)}</option>)}
          </Select>
        </div>
      </div>
      <p className="text-xs text-neutral-600">{t('composer.rules')}</p>
      {state.error ? <p role="alert" className="text-sm text-danger">{t(`errors.${state.error}`)}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>{pending ? t('composer.saving') : t('composer.save')}</Button>
        <Button type="button" variant="outline" onClick={onDone}>{t('composer.cancel')}</Button>
      </div>
    </form>
  );
}

function PostAction({ handle, action, label, variant }: { handle: string; action: typeof submitPostAction; label: string; variant: 'primary' | 'outline' }) {
  const t = useTranslations('businessCommunity.posts');
  const router = useRouter();
  const [state, run, pending] = useActionState(action, EMPTY);
  const handled = useRef<PostFormState | null>(null);
  useEffect(() => {
    if (state.ok && handled.current !== state) { handled.current = state; router.refresh(); }
  }, [state, router]);
  return (
    <form action={run} className="inline-flex flex-col gap-1">
      <input type="hidden" name="handle" value={handle} />
      <Button type="submit" size="sm" variant={variant} disabled={pending}>{label}</Button>
      {state.error ? <span role="alert" className="text-xs text-danger">{t(`errors.${state.error}`)}</span> : null}
    </form>
  );
}

const STAGE_VARIANT: Record<PostStage, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral', awaiting_review: 'warning', rejected: 'danger', live: 'success', suspended: 'danger', archived: 'neutral',
};

export function PostsManager({ posts, writable, defaultLocale, formatDate }: {
  posts: BusinessPost[]; writable: boolean; defaultLocale: string; formatDate: Record<string, string>;
}) {
  const t = useTranslations('businessCommunity.posts');
  const [composer, setComposer] = useState<{ editing: BusinessPost | null } | null>(null);
  const close = () => setComposer(null);
  const groups: { key: 'drafts' | 'review' | 'live' | 'rejected' | 'suspended' | 'archived'; stages: PostStage[] }[] = [
    { key: 'drafts', stages: ['draft'] }, { key: 'review', stages: ['awaiting_review'] }, { key: 'live', stages: ['live'] },
    { key: 'rejected', stages: ['rejected'] }, { key: 'suspended', stages: ['suspended'] }, { key: 'archived', stages: ['archived'] },
  ];
  return (
    <div className="space-y-5" data-testid="community-posts">
      {writable ? (
        composer ? (
          <PostComposer editing={composer.editing} onDone={close} defaultLocale={defaultLocale} key={composer.editing?.handle ?? 'new'} />
        ) : (
          <Button type="button" onClick={() => setComposer({ editing: null })}>{t('composer.new')}</Button>
        )
      ) : null}
      {posts.length === 0 ? <p className="text-sm text-neutral-600" data-testid="community-posts-empty">{t('empty')}</p> : null}
      {groups.map(({ key, stages }) => {
        const rows = posts.filter((p) => stages.includes(p.stage));
        if (rows.length === 0) return null;
        return (
          <section key={key} aria-labelledby={`posts-${key}`} className="space-y-2">
            <h3 id={`posts-${key}`} className="text-sm font-semibold">{t(`groups.${key}`)} <span className="text-neutral-500">({rows.length})</span></h3>
            <ul className="space-y-2">
              {rows.map((post) => (
                <li key={post.handle} className="rounded-md border border-neutral-200 p-3" data-testid="community-post" data-stage={post.stage}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={STAGE_VARIANT[post.stage]}>{t(`stages.${post.stage}`)}</Badge>
                    <span className="text-xs text-neutral-600">{t(`languages.${post.contentLocale as 'en'}`)} · {formatDate[post.handle] ?? ''}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm" dir="auto">{post.body}</p>
                  {post.linkUrl ? <p className="mt-1 break-all text-xs text-neutral-600" dir="ltr">{post.linkUrl}</p> : null}
                  {post.stage === 'rejected' && post.reasonCode ? (
                    <p className="mt-2 text-sm text-danger">{t('rejectedBecause', { reason: t(`reasons.${post.reasonCode as 'spam_or_duplicate'}`) })}</p>
                  ) : null}
                  {post.stage === 'awaiting_review' ? <p className="mt-2 text-xs text-neutral-600">{t('awaitingNote')}</p> : null}
                  {writable ? (
                    <div className="mt-3 flex flex-wrap items-start gap-2">
                      {CAN_EDIT.includes(post.stage) ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => setComposer({ editing: post })}>{t('actions.edit')}</Button>
                      ) : null}
                      {CAN_SUBMIT.includes(post.stage) ? <PostAction handle={post.handle} action={submitPostAction} label={t('actions.submit')} variant="primary" /> : null}
                      {CAN_ARCHIVE.includes(post.stage) ? <PostAction handle={post.handle} action={archivePostAction} label={t('actions.archive')} variant="outline" /> : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
