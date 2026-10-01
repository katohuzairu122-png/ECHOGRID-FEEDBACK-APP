import type { BusinessDto } from '@echo-grid-feedback/shared-types';
import { switchBusinessAction } from '@/lib/actions/business';

export function BusinessSwitcher({ businesses, activeBusinessId }: { businesses: BusinessDto[]; activeBusinessId: string }) {
  if (businesses.length < 2) return null;
  return (
    <form action={switchBusinessAction} className="flex items-center gap-2">
      <label htmlFor="active-business" className="text-xs font-medium text-neutral-500">Business</label>
      <select id="active-business" name="businessId" defaultValue={activeBusinessId} className="h-9 max-w-56 rounded-md border border-neutral-300 bg-white px-2 text-sm">
        {businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}
      </select>
      <button type="submit" className="h-9 rounded-md bg-neutral-100 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-200">Switch</button>
    </form>
  );
}

