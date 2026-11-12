import { describe, expect, it } from 'vitest';
import { classifyCashierInput } from './cashier-identifier';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMtMTIzIiwidHlwZSI6InFyX2N1c3RvbWVyIn0.c2lnbmF0dXJlLXZhbHVlLTEyMw';

describe('classifyCashierInput', () => {
  it('recognizes a signed customer QR token, including scanner padding', () => {
    expect(classifyCashierInput(TOKEN)).toEqual({ kind: 'token', value: TOKEN });
    expect(classifyCashierInput(`\u0002${TOKEN}\r\n`)).toEqual({ kind: 'token', value: TOKEN });
    expect(classifyCashierInput(`  ${TOKEN}  `)).toEqual({ kind: 'token', value: TOKEN });
  });

  it.each([
    ['+15551234567', '+15551234567'],
    ['+1 (555) 123-4567', '+15551234567'],
    ['+44 20 7946 0958', '+442079460958'],
    ['0044 20 7946 0958', '+442079460958'],
    ['+234.803.123.4567', '+2348031234567'],
    ['+1.555.123.4567', '+15551234567'],
    ['  +15551234567\n', '+15551234567'],
  ])('normalizes the phone number %j', (input, expected) => {
    expect(classifyCashierInput(input)).toEqual({ kind: 'phone', value: expected });
  });

  it('asks for the country code instead of guessing one', () => {
    expect(classifyCashierInput('5551234567')).toEqual({ kind: 'invalid', reason: 'countryCode' });
    expect(classifyCashierInput('(555) 123-4567')).toEqual({ kind: 'invalid', reason: 'countryCode' });
  });

  it.each(['', '   ', '\r\n'])('treats empty input %j as empty', (input) => {
    expect(classifyCashierInput(input)).toEqual({ kind: 'invalid', reason: 'empty' });
  });

  it.each([
    'hello',
    'abc.def',
    'aaaa.bbbb',
    '+1555',
    '+0555123456',
    '+1555123456789012345',
    '555-CALL-NOW',
    'javascript:alert(1)',
    `${TOKEN}.extra`,
  ])('does not guess for %j', (input) => {
    const result = classifyCashierInput(input);
    expect(result.kind).toBe('invalid');
  });

  it('keeps a short three-part token a token, and a dotted number a number', () => {
    expect(classifyCashierInput('aaa.bbb.ccc')).toEqual({ kind: 'token', value: 'aaa.bbb.ccc' });
    expect(classifyCashierInput('555.123.4567')).toEqual({ kind: 'invalid', reason: 'countryCode' });
    expect(classifyCashierInput('+1.555.123.4567')).toEqual({ kind: 'phone', value: '+15551234567' });
  });

  it('never treats a letter-bearing value as a phone number', () => {
    expect(classifyCashierInput('+1555abc4567').kind).toBe('invalid');
  });
});
