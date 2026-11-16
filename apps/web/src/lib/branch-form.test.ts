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
    const result = readBranchForm(formDataFrom({ name: 'Main Branch' }));
    expect(result.name).toBe('Main Branch');
    expect('slug' in result).toBe(false);
  });

  it('never sends a slug, even if a stale form still posts one', () => {
    expect('slug' in readBranchForm(formDataFrom({ name: 'Main', slug: 'sneaky-slug' }))).toBe(false);
  });

  it('treats a missing optional field as undefined, not an empty string', () => {
    const result = readBranchForm(formDataFrom({ name: 'Main' }));
    expect(result.city).toBeUndefined();
    expect(result.countryCode).toBeUndefined();
  });

  it('treats a whitespace-only optional field as undefined', () => {
    const result = readBranchForm(formDataFrom({ name: 'Main', city: '   ' }));
    expect(result.city).toBeUndefined();
  });

  it('keeps a genuinely filled-in optional field', () => {
    const result = readBranchForm(
      formDataFrom({ name: 'Main', city: 'Austin', countryCode: 'US' }),
    );
    expect(result.city).toBe('Austin');
    expect(result.countryCode).toBe('US');
  });

  it('defaults required fields to an empty string rather than throwing when absent -- server-side Zod validation is what actually rejects them', () => {
    const result = readBranchForm(formDataFrom({}));
    expect(result.name).toBe('');
    expect('slug' in result).toBe(false);
  });
});
