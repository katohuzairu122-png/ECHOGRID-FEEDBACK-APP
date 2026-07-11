'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { BranchDto } from '@echo-grid-feedback/shared-types';

interface BranchFilterProps {
  branches: BranchDto[];
  selectedBranchId?: string;
}

/**
 * Plain native <select>, not a custom Combobox -- no Select/Combobox
 * primitive exists yet in this design system (flagged as deferred scope
 * since Branch Mgmt Block 5), and a native select is fully accessible and
 * keyboard-operable without waiting on one. The URL's ?branchId= is the
 * source of truth, not client state, so the filtered view stays a plain
 * Server Component fetch, shareable and bookmarkable.
 */
export function BranchFilter({ branches, selectedBranchId }: BranchFilterProps) {
  const router = useRouter();
  // i18n & Multi-Currency Block 5.
  const t = useTranslations('feedback.staff');

  return (
    <select
      value={selectedBranchId ?? ''}
      onChange={(e) => {
        const value = e.target.value;
        router.push(value ? `/dashboard/feedback?branchId=${value}` : '/dashboard/feedback');
      }}
      aria-label={t('filterAriaLabel')}
      className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <option value="">{t('allBranches')}</option>
      {branches.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.name}
        </option>
      ))}
    </select>
  );
}
