import { getTranslations } from 'next-intl/server';
import type { CurrentUserDto } from '@echo-grid-feedback/shared-types';
import { logoutAction } from '@/lib/actions/auth';
import { Badge, Button } from '@/components/ui';
import { WorkspaceNavigation } from '@/components/workspace/workspace-navigation';

type PlatformRole = NonNullable<CurrentUserDto['platformRole']>;
export async function PlatformNav({ role }: { role: PlatformRole }) {
  const t = await getTranslations('platform.nav');
  return (
    <WorkspaceNavigation
      home="/platform"
      label={t('brand')}
      menuLabel={t('menu')}
      moreLabel={t('more')}
      closeLabel={t('close')}
      items={[
        { href: '/platform', label: t('brand'), icon: 'shield' },
        { href: '/platform/businesses', label: t('directory'), icon: 'store' },
        { href: '/platform/audit-log', label: t('auditLog'), icon: 'chart' },
        { href: '/platform/billing', label: t('billing'), icon: 'settings' },
        { href: '/dashboard', label: t('backToDashboard'), icon: 'arrow' },
      ]}
      utilities={
        <>
          <Badge variant="accent">{t('roleLabels.' + role)}</Badge>
          <form action={logoutAction}>
            <Button type="submit" variant="ghost">
              {t('logout')}
            </Button>
          </form>
        </>
      }
    />
  );
}
