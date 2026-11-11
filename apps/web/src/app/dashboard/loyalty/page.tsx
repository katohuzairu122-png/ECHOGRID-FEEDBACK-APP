import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActiveBusiness } from '@/lib/business';
import { apiFetch } from '@/lib/api-client';
import type { LoyaltyAccountWithCustomerDto } from '@echo-grid-feedback/shared-types';
import { Button } from '@/components/ui';
import { LoyaltySubnav } from './loyalty-subnav';
import { LoyaltyAccountCard } from './loyalty-account-card';
import { AccountDialog } from './account-dialog';
import { startConversationAction } from '@/lib/actions/messaging';
import styles from './loyalty-visual.module.css';

/** Staff landing page for Loyalty; the first 20 authorized business accounts
 * are a preview, NOT a total customer count. Preserve API membership scope,
 * original account actions, no unsupported paging. */
const PAGE_SIZE = 20;

export default async function LoyaltyDashboardPage() {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');

  const format = await getFormatter();
  const t = await getTranslations('loyalty.staff');

  const accounts = await apiFetch<LoyaltyAccountWithCustomerDto[]>(
    `/loyalty/accounts?limit=${PAGE_SIZE}`,
    { businessId: business.id },
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{business.name}</p>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className={styles.muted}>{t('accounts.description')}</p>
      </header>

      <LoyaltySubnav />

      {accounts.length === 0 ? (
        <section className={styles.empty}>
          <h2>{t('accounts.emptyTitle')}</h2>
          <p>{t('accounts.emptyDescription')}</p>
        </section>
      ) : (
        <section aria-label={t('accounts.sectionLabel')}>
          <div className={styles.listHeading}>
            <p className={styles.count}>{t('accounts.shownOnPage', { count: accounts.length })}</p>
          </div>
          <ul className={styles.accounts}>
            {accounts.map((account) => {
              const customer = account.customer.fullName ?? account.customer.phone;
              return (
                <li key={account.id}>
                  <LoyaltyAccountCard
                    customer={customer}
                    visitLabel={t('accounts.visits', { count: account.visitCount })}
                    lastVisitAt={account.lastVisitAt}
                    lastVisitLabel={
                      account.lastVisitAt
                        ? t('accounts.lastVisit', {
                            date: format.dateTime(new Date(account.lastVisitAt), 'short'),
                          })
                        : t('accounts.noVisits')
                    }
                    points={format.number(account.points)}
                    pointsLabel={t('accounts.pointsLabel')}
                    suspended={account.status !== 'active'}
                    suspendedLabel={t('accounts.suspended')}
                    actions={
                      <>
                        <form action={startConversationAction.bind(null, account.customer.id)}>
                          <Button type="submit" variant="outline" size="sm">
                            {t('accounts.message')}
                          </Button>
                        </form>
                        <AccountDialog accountId={account.id} customerLabel={customer} />
                      </>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
