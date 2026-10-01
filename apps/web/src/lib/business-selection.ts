import type { BusinessDto } from '@echo-grid-feedback/shared-types';

export function selectActiveBusiness(businesses: BusinessDto[], selectedId?: string): BusinessDto | null {
  return businesses.find((business) => business.id === selectedId) ?? businesses[0] ?? null;
}

