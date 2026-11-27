'use client';

import { useActionState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { programmeAction, type ProgrammeFormState } from '@/lib/actions/loyalty-programmes';
import type { ProgrammeDto, ProgrammeHistoryDto } from '@/lib/loyalty-programmes';
import { Badge, Button } from '@/components/ui';

const initial: ProgrammeFormState = {};

/** A confirmed single-step change (pause, retire or activate an existing programme). Owner-only on the API. */
function ConfirmAction({ programmeId, intent, label }: { programmeId: string; intent: 'pause' | 'retire' | 'activate-existing'; label: string }) {
  const [state, action, pending] = useActionState(programmeAction, initial);
  const t = useTranslations('loyalty.programmes');
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="programmeId" value={programmeId} />
      <input type="hidden" name="intent" value={intent} />
      <label className="flex items-center gap-1.5 text-xs">
        <input type="checkbox" name="confirm" value="yes" required />
        {t(`confirmLabel.${intent}`)}
      </label>
      <Button type="submit" variant="outline" disabled={pending}>{label}</Button>
      {state.errorCode ? <span role="alert" className="text-xs text-danger">{t(`errors.${state.errorCode}`)}</span> : null}
      {state.saved ? <span role="status" className="text-xs text-success">{t(`saved.${state.saved}`)}</span> : null}
    </form>
  );
}

/** What the business is running now: the programme, its version and status, and the changes available to its Owner. */
export function ActiveProgrammePanel({ active }: { active: ProgrammeDto | undefined }) {
  const t = useTranslations('loyalty.programmes');
  const format = useFormatter();
  if (!active) {
    return (
      <section className="rounded-lg border border-warning/50 bg-warning/5 p-4" role="status" aria-labelledby="no-programme-title">
        <h2 id="no-programme-title" className="font-semibold">{t('none.title')}</h2>
        <p className="text-sm">{t('none.body')}</p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border p-4" aria-labelledby="active-programme-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="active-programme-title" className="font-semibold">{t(`types.${active.type}.name`)}</h2>
        <Badge variant="success">{t('status.active')}</Badge>
        {active.legacy ? <Badge variant="neutral">{t('active.legacy')}</Badge> : null}
      </div>
      <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-neutral-500">{t('active.version')}: </dt><dd className="inline">{active.currentVersion}</dd></div>
        {active.activatedAt ? <div><dt className="inline text-neutral-500">{t('active.since')}: </dt><dd className="inline">{format.dateTime(new Date(active.activatedAt), { dateStyle: 'medium' })}</dd></div> : null}
      </dl>
      {active.legacy ? <p className="mt-2 text-xs text-neutral-500">{t('active.legacyNote')}</p> : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <Link className="inline-flex min-h-10 items-center rounded-md border px-3 text-sm" href={`/dashboard/loyalty/programme?edit=${active.id}#configure`}>{t('active.edit')}</Link>
        <ConfirmAction programmeId={active.id} intent="pause" label={t('actions.pause')} />
      </div>
    </section>
  );
}

/** Drafts, validated and paused programmes that can still be configured, activated (switching) or retired. */
export function OtherProgrammesPanel({ programmes }: { programmes: ProgrammeDto[] }) {
  const t = useTranslations('loyalty.programmes');
  const shown = programmes.filter((p) => p.status !== 'active' && p.status !== 'retired');
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby="other-programmes-title">
      <h2 id="other-programmes-title" className="mb-2 font-semibold">{t('others.title')}</h2>
      <ul className="flex flex-col gap-3">
        {shown.map((p) => (
          <li key={p.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t(`types.${p.type}.name`)}</span>
              <Badge variant="neutral">{t(`status.${p.status}`)}</Badge>
              <span className="text-xs text-neutral-500">{t('active.version')}: {p.currentVersion}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-3">
              {p.status !== 'inactive' ? <Link className="inline-flex min-h-10 items-center rounded-md border px-3 text-sm" href={`/dashboard/loyalty/programme?edit=${p.id}#configure`}>{t('active.edit')}</Link> : null}
              {p.status === 'validated' || p.status === 'inactive' ? <ConfirmAction programmeId={p.id} intent="activate-existing" label={p.status === 'inactive' ? t('actions.resume') : t('actions.activate')} /> : null}
              <ConfirmAction programmeId={p.id} intent="retire" label={t('actions.retire')} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Activation and configuration history of one programme (events and immutable configuration versions). */
export function ProgrammeHistoryPanel({ history }: { history: ProgrammeHistoryDto }) {
  const t = useTranslations('loyalty.programmes');
  const format = useFormatter();
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer font-medium">{t('history.title')}</summary>
      <ol className="mt-2 flex flex-col gap-1 text-sm">
        {history.events.map((e) => (
          <li key={e.id}>
            {format.dateTime(new Date(e.createdAt), { dateStyle: 'medium', timeStyle: 'short' })} — {t.has(`history.events.${e.eventType}`) ? t(`history.events.${e.eventType}`) : e.eventType}
            {e.version ? ` (v${e.version})` : ''}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-neutral-500">{t('history.versions', { count: history.versions.length })}</p>
    </details>
  );
}
