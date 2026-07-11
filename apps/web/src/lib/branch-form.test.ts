import { describe, it, expect } from 'vitest';
import { readBranchForm } from './branch-form';

function formDataFrom(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe('readBranchForm', () => {
  it('reads required fields as-is', () => {
    const result = readBranchForm(formDataFrom({ name: 'Main Branch', slug: 'main' }));
    expect(result.name).toBe('Main Branch');
    expect(result.slug).toBe('main');
  });

  it('treats a missing optional field as undefined, not an empty string', () => {
    const result = readBranchForm(formDataFrom({ name: 'Main', slug: 'main' }));
    expect(result.city).toBeUndefined();
    expect(result.countryCode).toBeUndefined();
  });

  it('treats a whitespace-only optional field as undefined', () => {
    const result = readBranchForm(formDataFrom({ name: 'Main', slug: 'main', city: '   ' }));
    expect(result.city).toBeUndefined();
  });

  it('keeps a genuinely filled-in optional field', () => {
    const result = readBranchForm(
      formDataFrom({ name: 'Main', slug: 'main', city: 'Austin', countryCode: 'US' }),
    );
    expect(result.city).toBe('Austin');
    expect(result.countryCode).toBe('US');
  });

  it('defaults required fields to an empty string rather than throwing when absent -- server-side Zod validation is what actually rejects them', () => {
    const result = readBranchForm(formDataFrom({}));
    expect(result.name).toBe('');
    expect(result.slug).toBe('');
  });
});
