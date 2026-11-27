import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { LoyaltyRewardDto } from '@echo-grid-feedback/shared-types';
import { isProgramAvailable, type LoyaltyProgramType } from '@echo-grid-feedback/shared-types';
import { getActiveBusiness } from '@/lib/business';
import { programmeGate } from '@/lib/workspace-guard';
import { apiFetch } from '@/lib/api-client';
import { eligiblePrizeRewards, type ProgrammeHistoryDto, type ProgrammesOverviewDto } from '@/lib/loyalty-programmes';
import { LoyaltySubnav } from '../loyalty-subnav';
import { ProgrammeCards } from '@/components/loyalty-programmes/programme-cards';
import { ProgrammeForm } from '@/components/loyalty-programmes/programme-form';
import { ActiveProgrammePanel, OtherProgrammesPanel, ProgrammeHistoryPanel } from '@/components/loyalty-programmes/programme-panels';

/**
 * Loyalty > Programme (LOYALTY-PROGRAMME-COMPLETION Groups 03 and 04). The same screen serves the registration step (`?setup=1`, with a
 * "Configure later" exit) and ongoing management: the business's primary programme, the eight programme cards, one configuration form per type,
 * programme switching with an explicit confirmation, and the configuration history. A cashier has no route here.
 */
export default async function LoyaltyProgrammePage({ searchParams }: { searchParams: Promise<{ type?: string; edit?: string; setup?: string }> }) {
  const business = await getActiveBusiness();
  if (!business) redirect('/dashboard');
  const blocked = await programmeGate();
  if (blocked) return blocked;

  const { type: typeParam, edit, setup } = await searchParams;
  const [overview, rewards] = await Promise.all([
    apiFetch<ProgrammesOverviewDto>('/loyalty/programmes', { businessId: business.id }),
    apiFetch<LoyaltyRewardDto[]>('/loyalty/rewards', { businessId: business.id }),
  ]);
  const t = await getTranslations('loyalty.programmes');
  const active = overview.programmes.find((p) => p.status === 'active');
  const editing = edit ? overview.programmes.find((p) => p.id === edit && p.status !== 'retired' && p.status !== 'inactive') : undefined;
  const formType: LoyaltyProgramType | undefined = editing?.type ?? (typeParam && isProgramAvailable(typeParam) ? typeParam : undefined);
  const history = active ? await apiFetch<ProgrammeHistoryDto>(`/loyalty/programmes/${active.id}/history`, { businessId: business.id }) : undefined;
  const isSetup = setup === '1';

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm text-neutral-500">{business.name}</p>
        <h1 className="text-2xl font-semibold text-neutral-900">{isSetup ? t('setup.title') : t('title')}</h1>
        <p className="text-sm text-neutral-600">{isSetup ? t('setup.intro') : t('subtitle')}</p>
      </header>

      {isSetup ? null : <LoyaltySubnav />}

      <ActiveProgrammePanel active={active} />

      <section aria-labelledby="choose-title" className="flex flex-col gap-3">
        <h2 id="choose-title" className="font-semibold">{active ? t('switch.title') : t('choose.title')}</h2>
        <p className="text-sm text-neutral-600">{active ? t('switch.body') : t('choose.body')}</p>
        <ProgrammeCards registry={overview.registry} activeType={active?.type} setup={isSetup} />
      </section>

      {formType ? (
        <section id="configure" aria-label={t('configure.title')} className="rounded-xl border bg-white p-5">
          <ProgrammeForm
            key={`${formType}:${editing?.id ?? 'new'}`}
            type={formType}
            programmeId={editing?.id}
            config={editing?.config ?? {}}
            rewards={eligiblePrizeRewards(rewards, formType).map((r) => ({ id: r.id, name: r.name }))}
            currency={business.defaultCurrency}
            setup={isSetup}
            replaces={active && active.id !== editing?.id ? t(`types.${active.type}.name`) : undefined}
          />
        </section>
      ) : null}

      <OtherProgrammesPanel programmes={overview.programmes} />
      {history ? <ProgrammeHistoryPanel history={history} /> : null}

      {isSetup ? (
        <p className="text-sm">
          <Link className="font-medium text-brand-700 hover:underline" href="/dashboard">{t('setup.later')}</Link>
          <span className="text-neutral-500"> — {t('setup.laterNote')}</span>
        </p>
      ) : null}
    </div>
  );
}

