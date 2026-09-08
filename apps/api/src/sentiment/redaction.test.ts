import { describe, it, expect } from 'vitest';
import { redactComment } from './redaction';

describe('redactComment -- generic patterns', () => {
  it('redacts an email address', () => {
    expect(redactComment('email me at john.smith@example.com please')).toBe(
      'email me at [email redacted] please',
    );
  });

  it('redacts common phone number formats', () => {
    expect(redactComment('call (555) 123-4567')).toBe('call [phone redacted]');
    expect(redactComment('call 555-123-4567')).toBe('call [phone redacted]');
    expect(redactComment('call 555.123.4567')).toBe('call [phone redacted]');
    expect(redactComment('call +1 555 123 4567')).toBe('call [phone redacted]');
    expect(redactComment('call 5551234567')).toBe('call [phone redacted]');
  });

  it('redacts multiple identifiers in the same comment', () => {
    expect(redactComment('reach me at jane@example.com or 555-123-4567')).toBe(
      'reach me at [email redacted] or [phone redacted]',
    );
  });

  it('leaves a comment with no PII completely unchanged', () => {
    const comment = 'The food was cold and the wait was way too long.';
    expect(redactComment(comment)).toBe(comment);
  });

  it('does not redact a bare short number that is not phone-shaped (e.g. a year or short count)', () => {
    const comment = 'I have visited 3 times since 2024 and order #482 was wrong.';
    expect(redactComment(comment)).toBe(comment);
  });
});

describe('redactComment -- known identifiers (this row\'s own customer fields)', () => {
  it('redacts the submitter\'s own name when it appears in the comment, case-insensitively', () => {
    expect(redactComment('Hi this is John Smith, great visit!', ['John Smith'])).toBe(
      'Hi this is [redacted], great visit!',
    );
    expect(redactComment('hi this is john smith', ['John Smith'])).toBe('hi this is [redacted]');
  });

  it('skips null, undefined, and blank identifiers without throwing', () => {
    expect(redactComment('great visit', [null, undefined, '', '   '])).toBe('great visit');
  });

  it('escapes regex-special characters in an identifier instead of treating them as regex syntax', () => {
    // A name containing '.' would otherwise match any character there,
    // and unescaped parens would form a capture group.
    expect(redactComment('contact D.J. (Dave) about this', ['D.J. (Dave)'])).toBe(
      'contact [redacted] about this',
    );
  });

  it('applies both the generic patterns and known-identifier matching together', () => {
    expect(
      redactComment('Maria here, email maria@example.com or find me at (555) 987-6543', [
        'Maria',
        'maria@example.com',
        '(555) 987-6543',
      ]),
    ).toBe('[redacted] here, email [email redacted] or find me at [phone redacted]');
  });
});
