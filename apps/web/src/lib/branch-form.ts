export interface BranchMutationInput {
  name: string;
  slug: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  countryCode?: string;
  timezone?: string;
}

/**
 * Empty-string form fields become `undefined` rather than `""` -- the
 * shared Zod schemas (createBranchSchema/updateBranchSchema) mark these
 * optional, and sending "" instead of omitting the key would fail their
 * .max()/.length() checks differently than leaving a field genuinely
 * blank is meant to behave.
 *
 * Deliberately NOT in lib/actions/branches.ts despite only being used
 * there: a 'use server' file's exports must ALL be async functions
 * (Next.js's build-time constraint on Server Action modules), and this is
 * a synchronous pure function with no reason to be one. Pulling it out
 * also makes it directly unit-testable with no React or Server Action
 * machinery involved at all -- see branch-form.test.ts.
 */
export function readBranchForm(formData: FormData): BranchMutationInput {
  const optional = (key: string): string | undefined => {
    const value = formData.get(key);
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };

  return {
    name: String(formData.get('name') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    addressLine1: optional('addressLine1'),
    addressLine2: optional('addressLine2'),
    city: optional('city'),
    stateProvince: optional('stateProvince'),
    postalCode: optional('postalCode'),
    countryCode: optional('countryCode'),
    timezone: optional('timezone'),
  };
}
