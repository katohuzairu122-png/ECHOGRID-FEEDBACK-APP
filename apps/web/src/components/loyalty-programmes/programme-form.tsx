'use client';

import { useActionState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { LoyaltyProgramType } from '@echo-grid-feedback/shared-types';
import { programmeAction, type ProgrammeFormState } from '@/lib/actions/loyalty-programmes';
import { Button } from '@/components/ui';
import { Lp01Fields, Lp02Fields, Lp03Fields, Lp04Fields, Lp05Fields, Lp06Fields, Lp07Fields, type PrizeReward } from './programme-fields';

const initial: ProgrammeFormState = {};

const FIELDS = { 'LP-01': Lp01Fields, 'LP-02': Lp02Fields, 'LP-03': Lp03Fields, 'LP-04': Lp04Fields, 'LP-05': Lp05Fields, 'LP-06': Lp06Fields, 'LP-07': Lp07Fields } as const;

export interface ProgrammeFormProps {
  type: LoyaltyProgramType;
  programmeId?: string | undefined;
  config: Record<string, unknown>;
  rewards: PrizeReward[];
  currency: string;
  /** True inside the registration step: a successful activation continues into the dashboard. */
  setup?: boolean | undefined;
  /** Name of the programme that will stop earning when this one is activated (the switch warning), if any. */
  replaces?: string | undefined;
}

/**
 * The configuration screen of ONE programme type: its own fields, a server-side preview of the customer's earning experience, "Save draft", and
 * an explicit, confirmed activation. Nothing is activated without the confirmation box, and activation is Owner-only on the API.
 */
export function ProgrammeForm({ type, programmeId, config, rewards, currency, setup, replaces }: ProgrammeFormProps) {
  const [state, action, pending] = useActionState(programmeAction, initial);
  const t = useTranslations('loyalty.programmes');
  const format = useFormatter();
  const Fields = FIELDS[type as keyof typeof FIELDS];
  if (!Fields) return <p role="status">{t('cards.reason.IN_DEVELOPMENT')}</p>;

  return (
    <form action={action} className="flex flex-col gap-6" aria-labelledby="programme-form-title">
      <input type="hidden" name="type" value={type} />
      <input type="hidden" name="programmeId" value={programmeId ?? state.programmeId ?? ''} />
      {setup ? <input type="hidden" name="setup" value="yes" /> : null}
      <h2 id="programme-form-title" className="text-lg font-semibold">{t(`types.${type}.name`)}</h2>
      <p className="text-sm text-neutral-600">{t(`types.${type}.summary`)}</p>

      <Fields config={config} rewards={rewards} currency={currency} />

      {state.errorCode ? (
        <div role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm text-danger">
          <p className="font-medium">{t(`errors.${state.errorCode}`)}</p>
          {state.issues && state.issues.length > 0 ? (
            <ul className="mt-1 list-disc ps-5">
              {state.issues.map((issue, i) => (
                <li key={`${issue.path}-${i}`}>
                  <span className="font-mono text-xs">{issue.path}</span>: {t.has(`issues.${issue.code}`) ? t(`issues.${issue.code}`) : t('issues.generic')}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {state.preview ? (
        <section aria-labelledby="preview-title" className="rounded-lg border bg-neutral-50 p-4">
          <h3 id="preview-title" className="text-sm font-semibold">{t('preview.title')}</h3>
          {state.preview.kind === 'table' ? (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-start text-neutral-500">
                  <th className="text-start font-medium">{t('preview.purchase')}</th>
                  <th className="text-start font-medium">{t('preview.earns')}</th>
                </tr>
              </thead>
              <tbody>
                {state.preview.rows.map((row) => (
                  <tr key={row.amount}>
                    <td>{format.number(Number(row.amount), { style: 'currency', currency })}</td>
                    <td>{row.qualifying ? t('preview.points', { count: row.points }) : t('preview.notQualifying')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <ul className="mt-2 list-disc ps-5 text-sm">
              {state.preview.lines.map((line, i) => (
                <li key={`${line.key}-${i}`}>{t(`preview.lines.${line.key}`, line.values)}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-neutral-500">{t('preview.note')}</p>
        </section>
      ) : null}

      {state.saved ? (
        <p role="status" className="rounded-lg border border-success/40 bg-success/5 p-3 text-sm text-success">{t(`saved.${state.saved}`)}</p>
      ) : null}

      <fieldset className="rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">{t('activation.title')}</legend>
        <ul className="list-disc ps-5 text-sm text-neutral-700">
          <li>{t('activation.keeps')}</li>
          <li>{t('activation.changes')}</li>
          <li>{t('activation.consent')}</li>
          {replaces ? <li className="font-medium">{t('activation.replaces', { name: replaces })}</li> : null}
        </ul>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" name="confirm" value="yes" className="mt-1" />
          <span>{t('activation.confirm')}</span>
        </label>
        <p className="mt-1 text-xs text-neutral-500">{t('activation.ownerOnly')}</p>
      </fieldset>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="intent" value="preview" variant="outline" disabled={pending}>{t('actions.preview')}</Button>
        <Button type="submit" name="intent" value="draft" variant="outline" disabled={pending}>{t('actions.saveDraft')}</Button>
        <Button type="submit" name="intent" value="activate" disabled={pending}>{pending ? t('actions.working') : t('actions.activate')}</Button>
      </div>
    </form>
  );
}
