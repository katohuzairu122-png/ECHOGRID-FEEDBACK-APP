'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { BranchDto } from '@echo-grid-feedback/shared-types';

interface BranchFilterProps {
  branches: BranchDto[];
  selectedBranchId?: string | undefined;
}

/**
 * Mirrors dashboard/feedback/branch-filter.tsx exactly (same native-select
 * reasoning: no Select/Combobox primitive exists yet, URL is the source of
 * truth). Kept as its own small copy rather than importing the feedback
 * page's version -- that component hardcodes /dashboard/feedback as its
 * navigation target, and this app has no shared-but-not-design-system
 * component location yet; a ~20-line duplicate is a smaller cost than
 * introducing one for a single reuse.
 */
export function BranchFilter({ branches, selectedBranchId }: BranchFilterProps) {
  const router = useRouter();
  // i18n & Multi-Currency Block 7.
  const t = useTranslations('analytics.branchFilter');

  return (
    <select
      value={selectedBranchId ?? ''}
      onChange={(e) => {
        const value = e.target.value;
        router.push(value ? `/dashboard/analytics?branchId=${value}` : '/dashboard/analytics');
      }}
      aria-label={t('ariaLabel')}
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
