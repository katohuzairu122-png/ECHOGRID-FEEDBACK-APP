'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { recordLinkOpenAction } from '@/lib/actions/community-follows';

/** The https link of a post. For a business post, opening it is also noted (once per day) so the business can see a thresholded total. */
export function PostLink({ href, handle, businessPost, className }: { href: string; handle: string; businessPost: boolean; className?: string | undefined }) {
  const t = useTranslations('loyalty.customer.community.feed');
  const [, startTransition] = useTransition();
  return (
    <a
      className={className}
      href={href}
      rel="noopener noreferrer nofollow"
      target="_blank"
      onClick={businessPost ? () => startTransition(() => { void recordLinkOpenAction(handle); }) : undefined}
    >
      {t('openLink')}
    </a>
  );
}
