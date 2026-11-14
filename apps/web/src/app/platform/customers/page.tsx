import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import type { PlatformCustomerDto } from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@/components/ui';

const PAGE_SIZE = 25;
const STATUS_VARIANT: Record<PlatformCustomerDto['status'], 'success' | 'danger' | 'warning'> = {
  active: 'success',
  suspended: 'warning',
  banned: 'danger',
};

interface PageProps {
  searchParams: Promise<{
    search?: string;
    status?: string;
    withoutBusiness?: string;
    offset?: string;
  }>;
}

/**
 * "Present, not exposed" (D3 amendment): lists that a customer exists with a
 * masked identifier and lets an admin act on them. Lookup is by customer id or
 * a full phone number; there is no browse of names or contact details.
 */
export default async function PlatformCustomersPage({ searchParams }: PageProps) {
  const t = await getTranslations('platform.customers');
  const format = await getFormatter();
  const { search, status, withoutBusiness, offset: offsetParam } = await searchParams;
  const offset = Number(offsetParam) || 0;

  let items: PlatformCustomerDto[] = [];
  let hasMore = false;
  let searchError: string | null = null;
  try {
    const query = new URLSearchParams({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      ...(withoutBusiness === 'true' ? { withoutBusiness: 'true' } : {}),
      limit: String(PAGE_SIZE + 1),
      offset: String(offset),
    });
    const page = await apiFetch<PlatformCustomerDto[]>(`/platform/customers?${query}`);
    hasMore = page.length > PAGE_SIZE;
    items = page.slice(0, PAGE_SIZE);
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) searchError = t('searchHint');
    else throw err;
  }

  const pageHref = (next: number) =>
    `/platform/customers?${new URLSearchParams({
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      ...(withoutBusiness === 'true' ? { withoutBusiness: 'true' } : {}),
      offset: String(next),
    })}`;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-neutral-900">{t('title')}</h1>
        <p className="text-sm text-neutral-500">{t('privacyNote')}</p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="search">{t('searchLabel')}</Label>
          <Input
            id="search"
            name="search"
            defaultValue={search ?? ''}
            placeholder={t('searchPlaceholder')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="status">{t('statusLabel')}</Label>
          <Select id="status" name="status" defaultValue={status ?? ''}>
            <option value="">{t('anyStatus')}</option>
            <option value="active">{t('status.active')}</option>
            <option value="suspended">{t('status.suspended')}</option>
            <option value="banned">{t('status.banned')}</option>
          </Select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            name="withoutBusiness"
            value="true"
            defaultChecked={withoutBusiness === 'true'}
          />
          {t('withoutBusiness')}
        </label>
        <Button type="submit">{t('apply')}</Button>
      </form>

      {searchError && (
        <p role="alert" className="text-sm text-danger">
          {searchError}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('listTitle')}</CardTitle>
          <CardDescription>{t('listDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {items.length === 0 && !searchError && (
            <p className="text-sm text-neutral-500">{t('empty')}</p>
          )}
          {items.map((c) => (
            <Link
              key={c.id}
              href={`/platform/customers/${c.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm hover:bg-neutral-50"
            >
              <span className="font-medium text-neutral-900">{c.maskedPhone}</span>
              <span className="text-neutral-500">
                {t('businessesCount', { count: c.businessCount })} ·{' '}
                {format.dateTime(new Date(c.joinedAt), { dateStyle: 'medium' })}
              </span>
              <Badge variant={STATUS_VARIANT[c.status]}>{t(`status.${c.status}`)}</Badge>
            </Link>
          ))}
        </CardContent>
      </Card>

      <div className="flex gap-4 text-sm">
        {offset > 0 && (
          <Link
            href={pageHref(Math.max(offset - PAGE_SIZE, 0))}
            className="text-brand-700 underline"
          >
            {t('newer')}
          </Link>
        )}
        {hasMore && (
          <Link href={pageHref(offset + PAGE_SIZE)} className="text-brand-700 underline">
            {t('older')}
          </Link>
        )}
      </div>
    </div>
  );
}
