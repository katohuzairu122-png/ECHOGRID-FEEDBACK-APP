import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { LoyaltyTierDto } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { canConfigureProgramme, getMyAccess } from '@/lib/permissions';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui';
import { LoyaltySubnav } from '../loyalty-subnav';
import { LoyaltyCatalogCard } from '../loyalty-catalog-card';
import styles from '../loyalty-catalog.module.css';
import { TierFormDialog } from './tier-form-dialog';
import { DeleteTierButton } from './delete-tier-button';

export default async function LoyaltyTiersPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  // Programme configuration is for the business owner and admins, not counter staff.
  if (!canConfigureProgramme(await getMyAccess())) redirect('/dashboard/loyalty');

  const t = await getTranslations('loyalty.staff');
  const tiers = await apiFetch<LoyaltyTierDto[]>('/loyalty/tiers', { businessId: business.id });
  const sorted = [...tiers].sort((a, b) => a.minPoints - b.minPoints);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{business.name}</p>
          <h1 className="text-2xl font-semibold">{t('subnav.tiers')}</h1>
        </div>
        <div className={styles.headerActions}>
          <TierFormDialog trigger={<Button type="button">{t('tiers.newButton')}</Button>} />
        </div>
      </header>

      <LoyaltySubnav />

      {sorted.length === 0 ? (
        <section className={styles.empty}>
          <h2>{t('tiers.emptyTitle')}</h2>
          <p>{t('tiers.emptyDescription')}</p>
        </section>
      ) : (
        <section aria-label={t('subnav.tiers')}>
          <ul className={styles.list}>
            {sorted.map((tier) => (
              <li key={tier.id}>
                <LoyaltyCatalogCard
                  kind="tier"
                  title={tier.name}
                  details={
                    <>
                      <span>{t('tiers.minPoints', { points: tier.minPoints })}</span>
                      {tier.benefits && <span>{tier.benefits}</span>}
                    </>
                  }
                  actions={
                    <>
                      <TierFormDialog
                        tier={tier}
                        trigger={
                          <Button type="button" variant="outline" size="sm">
                            {t('tiers.editButton')}
                          </Button>
                        }
                      />
                      <DeleteTierButton tierId={tier.id} tierName={tier.name} />
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
