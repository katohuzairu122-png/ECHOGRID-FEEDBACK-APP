import { describe, expect, it } from 'vitest';
import {
  updateCustomerProfileSchema,
  updateBusinessAppearanceSchema,
  CUSTOMER_AVATAR_KEYS,
  BUSINESS_LOGO_KEYS,
  BUSINESS_BRAND_COLOR_KEYS,
  BIO_MAX,
  DISPLAY_NAME_MAX,
} from '@echo-grid-feedback/shared-types';
import { maskLogin } from '../lib/mask-login';

describe('customer profile input', () => {
  it('trims and collapses the display name, and accepts letters from any language', () => {
    expect(updateCustomerProfileSchema.parse({ displayName: '  Amina   K.  ' }).displayName).toBe('Amina K.');
    expect(updateCustomerProfileSchema.parse({ displayName: 'محمد علي' }).displayName).toBe('محمد علي');
    expect(updateCustomerProfileSchema.parse({ displayName: 'J.R. Smith' }).displayName).toBe('J.R. Smith');
    expect(updateCustomerProfileSchema.parse({ displayName: 'José-María O\'Neil' }).displayName).toBe('José-María O\'Neil');
  });
  it.each(['', '   ', '12345', 'https://evil.example', 'a@b.co', 'www.x.com', 'shop.example.org', 'visit www', '<b>x</b>', 'x'.repeat(DISPLAY_NAME_MAX + 1), 'Amy 😀'])(
    'rejects display name %j (no links, addresses, symbols, empty or over-long names)',
    (displayName) => {
      expect(updateCustomerProfileSchema.safeParse({ displayName }).success).toBe(false);
    },
  );
  it('accepts a bio with line breaks and rejects control characters and over-length', () => {
    expect(updateCustomerProfileSchema.safeParse({ bio: 'Coffee lover.\nLoyal to local shops.' }).success).toBe(true);
    expect(updateCustomerProfileSchema.safeParse({ bio: 'x'.repeat(BIO_MAX) }).success).toBe(true);
    expect(updateCustomerProfileSchema.safeParse({ bio: 'x'.repeat(BIO_MAX + 1) }).success).toBe(false);
    expect(updateCustomerProfileSchema.safeParse({ bio: 'bad\u0007bell' }).success).toBe(false);
    expect(updateCustomerProfileSchema.safeParse({ bio: 'split line' }).success).toBe(false);
  });
  it('lets null clear a field, only knows catalogue avatars, and rejects unknown fields and empty bodies', () => {
    expect(updateCustomerProfileSchema.parse({ displayName: null, bio: null, avatarKey: null })).toEqual({ displayName: null, bio: null, avatarKey: null });
    for (const k of CUSTOMER_AVATAR_KEYS) expect(updateCustomerProfileSchema.safeParse({ avatarKey: k }).success).toBe(true);
    expect(updateCustomerProfileSchema.safeParse({ avatarKey: 'https://x/y.png' }).success).toBe(false);
    expect(updateCustomerProfileSchema.safeParse({ avatarKey: 'unicorn' }).success).toBe(false);
    expect(updateCustomerProfileSchema.safeParse({}).success).toBe(false);
    expect(updateCustomerProfileSchema.safeParse({ displayName: 'Amy', customerId: 'other' }).success).toBe(false);
  });
});

describe('business appearance input', () => {
  it('accepts only catalogue logos and colours, null to clear, and nothing else', () => {
    for (const k of BUSINESS_LOGO_KEYS) expect(updateBusinessAppearanceSchema.safeParse({ logoKey: k }).success).toBe(true);
    for (const k of BUSINESS_BRAND_COLOR_KEYS) expect(updateBusinessAppearanceSchema.safeParse({ brandColorKey: k }).success).toBe(true);
    expect(updateBusinessAppearanceSchema.parse({ logoKey: null, brandColorKey: null })).toEqual({ logoKey: null, brandColorKey: null });
    expect(updateBusinessAppearanceSchema.safeParse({ logoKey: 'logo.png' }).success).toBe(false);
    expect(updateBusinessAppearanceSchema.safeParse({ brandColorKey: '#ff0000' }).success).toBe(false);
    expect(updateBusinessAppearanceSchema.safeParse({}).success).toBe(false);
    expect(updateBusinessAppearanceSchema.safeParse({ logoKey: 'cup', businessId: 'x' }).success).toBe(false);
  });
});

describe('maskLogin', () => {
  it('masks e-mail and phone so the full value cannot be read back', () => {
    expect(maskLogin({ email: 'amina@example.com' })).toBe('a***@example.com');
    expect(maskLogin({ phone: '+15551234567' })).toBe('+1••••••••67');
    expect(maskLogin({ email: 'amina@example.com', phone: '+15551234567' })).toBe('a***@example.com');
    expect(maskLogin({})).toBeNull();
    expect(maskLogin({ phone: '123' })).toBeNull();
  });
});
