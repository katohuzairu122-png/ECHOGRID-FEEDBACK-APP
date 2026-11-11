'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { BranchDto } from '@echo-grid-feedback/shared-types';
import { Select } from '@/components/ui';
import styles from './feedback-inbox.module.css';

interface BranchFilterProps {
  branches: BranchDto[];
  selectedBranchId?: string | undefined;
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

  const id = useId();

  return (
    <div className={styles.fieldInline}>
      <label htmlFor={id}>{t('branchLabel')}</label>
      <Select
        id={id}
        value={selectedBranchId ?? ''}
        onChange={(e) => {
          const value = e.target.value;
          router.push(
            value
              ? `/dashboard/feedback?branchId=${encodeURIComponent(value)}`
              : '/dashboard/feedback',
          );
        }}
        aria-label={t('filterAriaLabel')}
        className="min-h-11 w-auto min-w-48 rounded-xl"
      >
        <option value="">{t('allBranches')}</option>
        {branches.map((branch) => (
          <option key={branch.id} value={branch.id}>
            {branch.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
