'use client';

import { useTranslations } from 'next-intl';
import { WorkspaceState } from '@/components/workspace/overview-components';

/** A failed section never shows raw error text or invented content: a plain message, nothing assumed available. */
export default function CommunityError() {
  const t = useTranslations('businessCommunity.states');
  return <WorkspaceState>{t('error')}</WorkspaceState>;
}
