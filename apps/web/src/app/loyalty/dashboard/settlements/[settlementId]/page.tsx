import { customerApiFetch } from '@/lib/customer-api-client';
import { publicApiFetch } from '@/lib/public-api-client';
import { ApiError } from '@/lib/api-client';
import type { BusinessPublicDto } from '@echo-grid-feedback/shared-types';
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
  const receiver = await publicApiFetch<BusinessPublicDto>(
    `/businesses/${settlement.receivingBusinessId}/public`,
    { cache: 'no-store' },
  ).catch((err: unknown) => {
    if (err instanceof ApiError) return null;
    throw err;
  });
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">Review orphan settlement</h1>
      <p>
        Business acceptance and your completion consent are independent. No loyalty points,
        Community Points, Partner Credits or invoice credits are granted here.
      </p>
      <SettlementReviewForm
        initial={settlement}
        businessName={receiver?.name ?? 'Receiving business (name unavailable)'}
      />
    </section>
  );
}
