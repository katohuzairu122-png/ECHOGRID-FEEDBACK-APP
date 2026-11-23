'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Label, Select, buttonVariants } from '@/components/ui';
import { cn } from '@/lib/utils';

export interface BusinessFinderLabels {
  searchLabel: string;
  searchPlaceholder: string;
  noMatches: string;
  selectLabel: string;
  selectPlaceholder: string;
  empty: string;
  loadError: string;
  /** Contain the literal "{name}", replaced client-side so the business name is never part of a translation lookup. */
  chosenTitleTemplate: string;
  chosenBodyTemplate: string;
  accountCta: string;
  accountNote: string;
}

/**
 * CUSTOMER-JOIN-HUB-02: client-side search over publicly listed business names (API currently caps the list at 100). Choosing one explains how to
 * join THAT business (scan its QR code) plus a link to open the customer account now. It creates no membership: the QR flow does.
 */
export function BusinessFinder({ names, loadFailed, labels }: { names: string[]; loadFailed: boolean; labels: BusinessFinderLabels }) {
  const selectId = useId();
  const [chosen, setChosen] = useState('');
  const [query, setQuery] = useState('');
  const filtered = names.filter((name) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  if (loadFailed) return <p role="status" className="text-sm text-neutral-600">{labels.loadError}</p>;
  if (names.length === 0) return <p role="status" className="text-sm text-neutral-600">{labels.empty}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${selectId}-search`}>{labels.searchLabel}</Label>
        <input
          id={`${selectId}-search`}
          type="search"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setChosen(''); }}
          placeholder={labels.searchPlaceholder}
          className="min-h-11 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-900"
        />
      </div>
      {filtered.length === 0 && <p role="status" className="text-sm text-neutral-600">{labels.noMatches}</p>}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={selectId}>{labels.selectLabel}</Label>
        <Select id={selectId} value={chosen} onChange={(e) => setChosen(e.target.value)}>
          <option value="">{labels.selectPlaceholder}</option>
          {filtered.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </Select>
      </div>
      {chosen && (
        <div role="status" className="rounded-md border border-brand-200 bg-brand-50 p-4">
          <p className="font-medium text-neutral-900">{labels.chosenTitleTemplate.replace('{name}', chosen)}</p>
          <p className="mt-1 text-sm text-neutral-700">{labels.chosenBodyTemplate.replace('{name}', chosen)}</p>
          <Link href="/loyalty/login" className={cn(buttonVariants(), 'mt-3 w-full')}>
            {labels.accountCta}
          </Link>
          <p className="mt-2 text-xs text-neutral-500">{labels.accountNote}</p>
        </div>
      )}
    </div>
  );
}
