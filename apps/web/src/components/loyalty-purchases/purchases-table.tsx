import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui';
import type { PurchaseDto } from '@/lib/loyalty-purchases';

/** LPC-10: the Owner's purchase history. Amounts are shown exactly as stored (decimal text); a reversed purchase shows what the reversal did. */
export function PurchasesTable({ items, currency }: { items: PurchaseDto[]; currency: string }) {
  const t = useTranslations('loyalty.purchases');
  const format = useFormatter();
  if (items.length === 0) return <p className="text-sm text-neutral-600" data-testid="purchases-empty">{t('empty')}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border bg-white">
      <table className="w-full text-sm" data-testid="purchases-table">
        <caption className="sr-only">{t('title')}</caption>
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            <th scope="col" className="px-3 py-2">{t('columns.date')}</th>
            <th scope="col" className="px-3 py-2">{t('columns.customer')}</th>
            <th scope="col" className="px-3 py-2 text-right">{t('columns.amount')}</th>
            <th scope="col" className="px-3 py-2 text-right">{t('columns.points')}</th>
            <th scope="col" className="px-3 py-2">{t('columns.status')}</th>
            <th scope="col" className="px-3 py-2"><span className="sr-only">{t('columns.action')}</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} className="border-t">
              <td className="px-3 py-2">{format.dateTime(new Date(p.occurredAt), { dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td className="px-3 py-2">{p.customerName ?? t('unnamed')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{p.amount} {currency}</td>
              <td className="px-3 py-2 text-right tabular-nums">{p.pointsEarned}</td>
              <td className="px-3 py-2">
                {p.status === 'reversed' ? (
                  <Badge variant="accent">{t('status.reversed')}</Badge>
                ) : (
                  <Badge variant="brand">{t(`status.${p.status}`)}</Badge>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <Link className="font-medium text-brand-700 hover:underline" href={`/dashboard/loyalty/purchases/${p.id}`}>
                  {p.status === 'confirmed' ? t('review') : t('details')}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
