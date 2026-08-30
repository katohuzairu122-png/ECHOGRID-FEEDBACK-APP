'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { LoyaltyRewardDto } from '@echo-grid-feedback/shared-types';
import { redeemRewardAction, type RedeemState } from '@/lib/actions/loyalty-customer';
import { Badge, Button, Card, CardContent, CardDescription, CardTitle } from '@/components/ui';

const initialState: RedeemState = {};

interface RewardCardProps {
  reward: LoyaltyRewardDto;
  businessId: string;
  currentPoints?: number;
  /** Block 6.7.3 (S6.3 campaign dashboard) -- staff-facing preview mode.
   * Renders the same catalog-card visuals a customer sees (name,
   * description, points/value badge) but never the redemption form or
   * its error/success states -- a staff member viewing a campaign's
   * dashboard should see what the reward looks like, not get a live
   * "Redeem" button wired to their own (non-customer) session. Defaults
   * to false; the customer-facing catalog
   * (loyalty/dashboard/[businessId]/page.tsx, this component's original
   * caller) passes neither this nor a changed currentPoints, so it is
   * fully unaffected. */
  readOnly?: boolean;
}

/**
 * One reward, one independent useActionState instance -- each card in the
 * catalog redeems on its own, so a customer redeeming one reward doesn't
 * need the whole page to re-render around a single shared form. Mirrors
 * feedback-form.tsx's inline-success-swap pattern (no Dialog/Toast) once a
 * redemption succeeds: the card replaces its "Redeem" button with the code
 * the customer shows staff at the counter.
 */
export function RewardCard({ reward, businessId, currentPoints = 0, readOnly = false }: RewardCardProps) {
  const [state, formAction, pending] = useActionState(
    redeemRewardAction.bind(null, businessId),
    initialState,
  );
  // CI fix (Continuing Development Block 6.6): pointsCost is nullable since
  // Block 6.1 -- non-'points'-type rewards (discount/free_item/voucher) use
  // rewardValue instead and never get a pointsCost. loyaltyRewardSchema (the
  // response DTO) was corrected to say so in Block 6.6, which is what
  // surfaces this guard; every reward that exists today is points-type with
  // a real pointsCost, so this doesn't change current behavior. A non-points
  // reward simply can't be "afforded" through this points-based card --
  // customer redemption UX for the other types is the still-open,
  // already-named apps/web follow-up, not something this fix attempts.
  const canAfford = reward.pointsCost !== null && currentPoints >= reward.pointsCost;
  // i18n & Multi-Currency Block 6.
  const t = useTranslations('loyalty.customer.rewardCard');

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">{reward.name}</CardTitle>
            {reward.description && <CardDescription>{reward.description}</CardDescription>}
          </div>
          {reward.pointsCost !== null && (
            <Badge variant="accent">{t('points', { points: reward.pointsCost })}</Badge>
          )}
        </div>

        {!readOnly &&
          (state.result ? (
            <div className="rounded-md border border-brand-200 bg-brand-50 p-3 text-center">
              <p className="text-xs text-neutral-600">{t('showCode')}</p>
              <p className="text-2xl font-semibold tracking-widest text-brand-700">
                {state.result.redemptionCode}
              </p>
            </div>
          ) : (
            <form action={formAction}>
              <input type="hidden" name="rewardId" value={reward.id} />
              <Button type="submit" disabled={pending || !canAfford} size="sm" className="w-full">
                {pending ? t('redeeming') : canAfford ? t('redeem') : t('notEnoughPoints')}
              </Button>
            </form>
          ))}
        {!readOnly && state.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
