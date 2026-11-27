'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Input, Label, Select } from '@/components/ui';

/**
 * One configuration form PER programme type (there is deliberately no generic form): each component owns the fields and wording of its own
 * programme. Field names match `buildProgrammeConfig` in lib/loyalty-programmes.ts.
 */
export interface PrizeReward {
  id: string;
  name: string;
}
interface FieldsProps {
  config: Record<string, unknown>;
  rewards: PrizeReward[];
  currency: string;
}

const str = (v: unknown, fallback = ''): string => (v === undefined || v === null ? fallback : String(v));

function RewardSelect({ name, rewards, value }: { name: string; rewards: PrizeReward[]; value?: string | undefined }) {
  const t = useTranslations('loyalty.programmes.form');
  return (
    <Select id={name} name={name} defaultValue={value ?? ''} required>
      <option value="" disabled>
        {t('chooseReward')}
      </option>
      {rewards.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </Select>
  );
}
function NoRewardsNote({ rewards }: { rewards: PrizeReward[] }) {
  const t = useTranslations('loyalty.programmes.form');
  return rewards.length === 0 ? <p className="text-sm text-warning" role="note">{t('noRewards')}</p> : null;
}
function Field({ id, label, hint, children }: { id: string; label: string; hint?: string | undefined; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

export function Lp03Fields({ config, currency }: FieldsProps) {
  const t = useTranslations('loyalty.programmes.form');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="pointsPerCurrencyUnit" label={t('pointsPerUnit', { currency })} hint={t('pointsPerUnitHint')}>
        <Input id="pointsPerCurrencyUnit" name="pointsPerCurrencyUnit" inputMode="decimal" defaultValue={str(config.pointsPerCurrencyUnit, '1')} required />
      </Field>
      <Field id="pointsPerCheckin" label={t('pointsPerCheckin')} hint={t('pointsPerCheckinHint')}>
        <Input id="pointsPerCheckin" name="pointsPerCheckin" inputMode="numeric" defaultValue={str(config.pointsPerCheckin, '0')} required />
      </Field>
    </div>
  );
}

export function Lp02Fields({ config, currency }: FieldsProps) {
  const t = useTranslations('loyalty.programmes.form');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="pointsPerPurchase" label={t('pointsPerPurchase')} hint={t('pointsPerPurchaseHint')}>
        <Input id="pointsPerPurchase" name="pointsPerPurchase" inputMode="numeric" defaultValue={str(config.pointsPerPurchase, '10')} required />
      </Field>
      <Field id="minimumPurchaseAmount" label={t('minimumAmount', { currency })} hint={t('minimumAmountHint')}>
        <Input id="minimumPurchaseAmount" name="minimumPurchaseAmount" inputMode="decimal" defaultValue={str(config.minimumPurchaseAmount)} />
      </Field>
      <Field id="pointsPerCheckin" label={t('pointsPerCheckin')} hint={t('checkinDistinct')}>
        <Input id="pointsPerCheckin" name="pointsPerCheckin" inputMode="numeric" defaultValue={str(config.pointsPerCheckin, '0')} required />
      </Field>
    </div>
  );
}

export function Lp01Fields({ config, rewards, currency }: FieldsProps) {
  const t = useTranslations('loyalty.programmes.form');
  const [mode, setMode] = useState<'never' | 'days'>(typeof config.stampExpiryDays === 'number' ? 'days' : 'never');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="stampThreshold" label={t('stampThreshold')} hint={t('stampThresholdHint')}>
        <Input id="stampThreshold" name="stampThreshold" inputMode="numeric" defaultValue={str(config.stampThreshold, '5')} required />
      </Field>
      <Field id="rewardId" label={t('freeItemReward')} hint={t('freeItemHint')}>
        <RewardSelect name="rewardId" rewards={rewards} value={str(config.rewardId)} />
      </Field>
      <Field id="minimumPurchaseAmount" label={t('minimumAmount', { currency })} hint={t('stampMinimumHint')}>
        <Input id="minimumPurchaseAmount" name="minimumPurchaseAmount" inputMode="decimal" defaultValue={str(config.minimumPurchaseAmount)} />
      </Field>
      <Field id="expiryMode" label={t('stampExpiry')} hint={t('stampExpiryHint')}>
        <Select id="expiryMode" name="expiryMode" value={mode} onChange={(e) => setMode(e.target.value as 'never' | 'days')}>
          <option value="never">{t('expiryNever')}</option>
          <option value="days">{t('expiryDays')}</option>
        </Select>
      </Field>
      {mode === 'days' ? (
        <Field id="stampExpiryDays" label={t('expiryDaysLabel')}>
          <Input id="stampExpiryDays" name="stampExpiryDays" inputMode="numeric" defaultValue={str(config.stampExpiryDays, '90')} required />
        </Field>
      ) : null}
      <p className="text-sm text-neutral-600 sm:col-span-2">{t('resetOnCompletion')}</p>
      <div className="sm:col-span-2"><NoRewardsNote rewards={rewards} /></div>
    </div>
  );
}

export function Lp04Fields({ config, rewards, currency }: FieldsProps) {
  const t = useTranslations('loyalty.programmes.form');
  const initial = (config.milestones as { threshold: string; rewardId: string }[] | undefined) ?? [{ threshold: '', rewardId: '' }];
  const [count, setCount] = useState(Math.max(1, initial.length));
  const [metric, setMetric] = useState(str(config.metric, 'purchases'));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="metric" label={t('milestoneMetric')} hint={t('notATier')}>
          <Select id="metric" name="metric" value={metric} onChange={(e) => setMetric(e.target.value)}>
            <option value="purchases">{t('metricPurchases')}</option>
            <option value="visits">{t('metricVisits')}</option>
            <option value="spend">{t('metricSpend', { currency })}</option>
          </Select>
        </Field>
        {metric === 'purchases' ? (
          <Field id="minimumPurchaseAmount" label={t('minimumAmount', { currency })}>
            <Input id="minimumPurchaseAmount" name="minimumPurchaseAmount" inputMode="decimal" defaultValue={str(config.minimumPurchaseAmount)} />
          </Field>
        ) : null}
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">{t('milestones')}</legend>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="grid gap-3 sm:grid-cols-2">
            <Field id={`milestones.${i}.threshold`} label={t('threshold', { n: i + 1 })} hint={i === 0 ? t('ascendingHint') : undefined}>
              <Input id={`milestones.${i}.threshold`} name={`milestones.${i}.threshold`} inputMode="decimal" defaultValue={initial[i]?.threshold ?? ''} required />
            </Field>
            <Field id={`milestones.${i}.rewardId`} label={t('milestoneReward', { n: i + 1 })}>
              <RewardSelect name={`milestones.${i}.rewardId`} rewards={rewards} value={initial[i]?.rewardId} />
            </Field>
          </div>
        ))}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setCount((c) => Math.min(20, c + 1))}>{t('addRow')}</Button>
          {count > 1 ? <Button type="button" variant="outline" onClick={() => setCount((c) => Math.max(1, c - 1))}>{t('removeRow')}</Button> : null}
        </div>
      </fieldset>
      <NoRewardsNote rewards={rewards} />
    </div>
  );
}

export function Lp05Fields({ config, rewards, currency }: FieldsProps) {
  const t = useTranslations('loyalty.programmes.form');
  const [evidence, setEvidence] = useState(str(config.evidence, 'visit'));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="period" label={t('streakPeriod')}>
        <Select id="period" name="period" defaultValue={str(config.period, 'day')}>
          <option value="day">{t('periodDay')}</option>
          <option value="week">{t('periodWeek')}</option>
        </Select>
      </Field>
      <Field id="requiredPeriods" label={t('requiredPeriods')} hint={t('requiredPeriodsHint')}>
        <Input id="requiredPeriods" name="requiredPeriods" inputMode="numeric" defaultValue={str(config.requiredPeriods, '5')} required />
      </Field>
      <Field id="gracePeriods" label={t('gracePeriods')} hint={t('graceHint')}>
        <Input id="gracePeriods" name="gracePeriods" inputMode="numeric" defaultValue={str(config.gracePeriods, '0')} required />
      </Field>
      <Field id="evidence" label={t('streakEvidence')} hint={t('localTimeNote')}>
        <Select id="evidence" name="evidence" value={evidence} onChange={(e) => setEvidence(e.target.value)}>
          <option value="visit">{t('evidenceVisit')}</option>
          <option value="purchase">{t('evidencePurchase')}</option>
        </Select>
      </Field>
      {evidence === 'purchase' ? (
        <Field id="minimumPurchaseAmount" label={t('minimumAmount', { currency })}>
          <Input id="minimumPurchaseAmount" name="minimumPurchaseAmount" inputMode="decimal" defaultValue={str(config.minimumPurchaseAmount)} />
        </Field>
      ) : null}
      <Field id="rewardId" label={t('streakReward')}>
        <RewardSelect name="rewardId" rewards={rewards} value={str(config.rewardId)} />
      </Field>
      <div className="sm:col-span-2"><NoRewardsNote rewards={rewards} /></div>
    </div>
  );
}

const DAY_KEYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function Lp06Fields({ config, currency }: FieldsProps) {
  const t = useTranslations('loyalty.programmes.form');
  const initial = (config.windows as { days: number[]; start: string; end: string; multiplier?: string; bonusPoints?: number }[] | undefined) ?? [{ days: [1, 2, 3, 4, 5], start: '14:00', end: '17:00', multiplier: '2' }];
  const [count, setCount] = useState(Math.max(1, initial.length));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="pointsPerCurrencyUnit" label={t('pointsPerUnit', { currency })} hint={t('pointsPerUnitHint')}>
          <Input id="pointsPerCurrencyUnit" name="pointsPerCurrencyUnit" inputMode="decimal" defaultValue={str(config.pointsPerCurrencyUnit, '1')} required />
        </Field>
        <Field id="pointsPerCheckin" label={t('pointsPerCheckin')}>
          <Input id="pointsPerCheckin" name="pointsPerCheckin" inputMode="numeric" defaultValue={str(config.pointsPerCheckin, '0')} required />
        </Field>
        <Field id="effectiveFrom" label={t('effectiveFrom')} hint={t('localDateHint')}>
          <Input id="effectiveFrom" name="effectiveFrom" type="date" defaultValue={str(config.effectiveFrom)} />
        </Field>
        <Field id="effectiveUntil" label={t('effectiveUntil')}>
          <Input id="effectiveUntil" name="effectiveUntil" type="date" defaultValue={str(config.effectiveUntil)} />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-4">
        <legend className="text-sm font-medium">{t('windows')}</legend>
        <p className="text-xs text-neutral-500">{t('windowsHint')}</p>
        {Array.from({ length: count }, (_, i) => {
          const w = initial[i];
          return (
            <div key={i} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
              <div className="flex flex-wrap gap-3 sm:col-span-2" role="group" aria-label={t('windowDays', { n: i + 1 })}>
                {DAY_KEYS.map((d) => (
                  <label key={d} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name={`windows.${i}.days`} value={d} defaultChecked={w?.days.includes(d) ?? false} />
                    {t(`day${d}`)}
                  </label>
                ))}
              </div>
              <Field id={`windows.${i}.start`} label={t('windowStart')}>
                <Input id={`windows.${i}.start`} name={`windows.${i}.start`} type="time" defaultValue={w?.start ?? ''} required />
              </Field>
              <Field id={`windows.${i}.end`} label={t('windowEnd')}>
                <Input id={`windows.${i}.end`} name={`windows.${i}.end`} type="time" defaultValue={w?.end ?? ''} required />
              </Field>
              <Field id={`windows.${i}.mode`} label={t('bonusType')}>
                <Select id={`windows.${i}.mode`} name={`windows.${i}.mode`} defaultValue={w?.bonusPoints !== undefined ? 'bonus' : 'multiplier'}>
                  <option value="multiplier">{t('bonusMultiplier')}</option>
                  <option value="bonus">{t('bonusFixed')}</option>
                </Select>
              </Field>
              <Field id={`windows.${i}.value`} label={t('bonusValue')} hint={t('bonusValueHint')}>
                <Input id={`windows.${i}.value`} name={`windows.${i}.value`} inputMode="decimal" defaultValue={w?.bonusPoints !== undefined ? String(w.bonusPoints) : str(w?.multiplier, '2')} required />
              </Field>
            </div>
          );
        })}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => setCount((c) => Math.min(10, c + 1))}>{t('addWindow')}</Button>
          {count > 1 ? <Button type="button" variant="outline" onClick={() => setCount((c) => Math.max(1, c - 1))}>{t('removeWindow')}</Button> : null}
        </div>
        <p className="text-xs text-neutral-500">{t('currencyNote', { currency })}</p>
      </fieldset>
    </div>
  );
}

export function Lp07Fields({ config, rewards, currency }: FieldsProps) {
  const t = useTranslations('loyalty.programmes.form');
  const initial = (config.missions as { key: string; objective: string; target: string; windowDays: number; minimumPurchaseAmount?: string; rewardId: string }[] | undefined) ?? [{ key: '', objective: 'purchases', target: '3', windowDays: 7, rewardId: '' }];
  const [count, setCount] = useState(Math.max(1, initial.length));
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="text-sm font-medium">{t('missions')}</legend>
      <p className="text-xs text-neutral-500">{t('missionsHint')}</p>
      {Array.from({ length: count }, (_, i) => {
        const m = initial[i];
        return (
          <div key={i} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <Field id={`missions.${i}.key`} label={t('missionKey')} hint={t('missionKeyHint')}>
              <Input id={`missions.${i}.key`} name={`missions.${i}.key`} defaultValue={m?.key ?? ''} required />
            </Field>
            <Field id={`missions.${i}.objective`} label={t('missionObjective')}>
              <Select id={`missions.${i}.objective`} name={`missions.${i}.objective`} defaultValue={m?.objective ?? 'purchases'}>
                <option value="purchases">{t('objectivePurchases')}</option>
                <option value="spend">{t('objectiveSpend', { currency })}</option>
                <option value="visits">{t('objectiveVisits')}</option>
              </Select>
            </Field>
            <Field id={`missions.${i}.target`} label={t('missionTarget')}>
              <Input id={`missions.${i}.target`} name={`missions.${i}.target`} inputMode="decimal" defaultValue={m?.target ?? ''} required />
            </Field>
            <Field id={`missions.${i}.windowDays`} label={t('missionDays')} hint={t('missionDaysHint')}>
              <Input id={`missions.${i}.windowDays`} name={`missions.${i}.windowDays`} inputMode="numeric" defaultValue={str(m?.windowDays, '7')} required />
            </Field>
            <Field id={`missions.${i}.minimumPurchaseAmount`} label={t('minimumAmount', { currency })} hint={t('missionMinimumHint')}>
              <Input id={`missions.${i}.minimumPurchaseAmount`} name={`missions.${i}.minimumPurchaseAmount`} inputMode="decimal" defaultValue={str(m?.minimumPurchaseAmount)} />
            </Field>
            <Field id={`missions.${i}.rewardId`} label={t('missionReward')}>
              <RewardSelect name={`missions.${i}.rewardId`} rewards={rewards} value={m?.rewardId} />
            </Field>
          </div>
        );
      })}
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => setCount((c) => Math.min(10, c + 1))}>{t('addMission')}</Button>
        {count > 1 ? <Button type="button" variant="outline" onClick={() => setCount((c) => Math.max(1, c - 1))}>{t('removeMission')}</Button> : null}
      </div>
      <NoRewardsNote rewards={rewards} />
    </fieldset>
  );
}
