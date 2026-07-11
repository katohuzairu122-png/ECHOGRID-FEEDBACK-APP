import { describe, it, expect } from 'vitest';
import { readFeedbackForm } from './feedback-form';

function formDataFrom(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

describe('readFeedbackForm', () => {
  it('reads rating as a number', () => {
    const result = readFeedbackForm(formDataFrom({ rating: '4' }));
    expect(result.rating).toBe(4);
  });

  it('treats a missing optional field as undefined, not an empty string', () => {
    const result = readFeedbackForm(formDataFrom({ rating: '5' }));
    expect(result.comment).toBeUndefined();
    expect(result.customerEmail).toBeUndefined();
  });

  it('treats a whitespace-only optional field as undefined', () => {
    const result = readFeedbackForm(formDataFrom({ rating: '5', comment: '   ' }));
    expect(result.comment).toBeUndefined();
  });

  it('keeps a genuinely filled-in optional field', () => {
    const result = readFeedbackForm(
      formDataFrom({ rating: '5', comment: 'Great service!', customerName: 'Alex' }),
    );
    expect(result.comment).toBe('Great service!');
    expect(result.customerName).toBe('Alex');
  });

  it('defaults rating to 0 rather than throwing when absent -- Number(null) is 0, not NaN, and server-side Zod validation (min 1) is what actually rejects it', () => {
    const result = readFeedbackForm(formDataFrom({}));
    expect(result.rating).toBe(0);
  });
});
