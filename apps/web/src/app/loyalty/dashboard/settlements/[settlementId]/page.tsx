import { customerApiFetch } from '@/lib/customer-api-client';
import type { SettlementView } from '@/lib/settlement-types';
import { SettlementReviewForm } from './settlement-review-form';
export default async function SettlementReviewPage({
  params,
}: {
  params: Promise<{ settlementId: string }>;
}) {
  const { settlementId } = await params;
  const { settlement } = await customerApiFetch<{ settlement: SettlementView }>(
    `/orphan-settlements/${encodeURIComponent(settlementId)}`,
    { cache: 'no-store' },
  );
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">Review orphan settlement</h1>
      <p>
        Business acceptance and your completion consent are independent. No loyalty points,
        Community Points, Partner Credits or invoice credits are granted here.
      </p>
      <SettlementReviewForm initial={settlement} />
    </section>
  );
}
