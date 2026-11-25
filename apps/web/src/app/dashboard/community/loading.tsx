import { getTranslations } from 'next-intl/server';
import { WorkspaceState } from '@/components/workspace/overview-components';

export default async function CommunityLoading() {
  const t = await getTranslations('businessCommunity.states');
  return <WorkspaceState>{t('loading')}</WorkspaceState>;
}
