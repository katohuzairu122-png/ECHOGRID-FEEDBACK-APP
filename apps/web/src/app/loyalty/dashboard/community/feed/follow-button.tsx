'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { setFollowAction, type FollowState } from '@/lib/actions/community-follows';
import styles from '../community-sections.module.css';

const INITIAL: FollowState = {};

/** Follow / unfollow one business. Says plainly what a follow is NOT, and shows a failure instead of silently doing nothing. */
export function FollowButton({ handle, following, name }: { handle: string; following: boolean; name: string }) {
  const t = useTranslations('loyalty.customer.community.feed');
  const router = useRouter();
  const [state, action, pending] = useActionState(setFollowAction, INITIAL);
  const handled = useRef<FollowState | null>(null);
  useEffect(() => {
    if (state.ok && handled.current !== state) { handled.current = state; router.refresh(); }
  }, [state, router]);
  return (
    <form action={action} className={styles.followForm}>
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="follow" value={following ? 'no' : 'yes'} />
      <button type="submit" className={styles.action} disabled={pending} aria-pressed={following}
        aria-label={following ? t('unfollowLabel', { name }) : t('followLabel', { name })}>
        {following ? t('following') : t('follow')}
      </button>
      {state.error ? <span role="alert">{t(`followErrors.${state.error}`)}</span> : null}
    </form>
  );
}
