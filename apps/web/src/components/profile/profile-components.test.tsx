import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import { CUSTOMER_AVATAR_KEYS } from '@echo-grid-feedback/shared-types';
import { AVATAR_STYLE } from './avatar-catalogue';
import { ProfileAvatar } from './profile-avatar';
import { AvatarPicker } from './avatar-picker';
import { SignedInAs } from './signed-in-as';

const labels = { fallback: 'Customer', signedInAs: 'Signed in as', profile: 'My profile' };
const profile = { displayName: 'Mina', bio: null, avatarKey: 'leaf' as const, fullName: 'Amina Kato', maskedLogin: 'a***@example.com' };

describe('avatar catalogue', () => {
  it('draws every key the shared catalogue defines, and nothing else', () => {
    expect(Object.keys(AVATAR_STYLE).sort()).toEqual([...CUSTOMER_AVATAR_KEYS].sort());
  });
});

describe('ProfileAvatar', () => {
  it('shows initials when no avatar is chosen and is decorative by default', () => {
    const { container } = render(<ProfileAvatar avatarKey={null} name="Amina Kato" />);
    expect(container.textContent).toBe('AK');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
  it('is announced as an image when given a label', () => {
    render(<ProfileAvatar avatarKey="sun" name="Amina" label="Sun avatar" />);
    expect(screen.getByRole('img', { name: 'Sun avatar' })).toBeInTheDocument();
  });
});

describe('AvatarPicker', () => {
  it('offers none plus every avatar, starts on the saved one, and submits its key', () => {
    const { container } = renderWithIntl(<AvatarPicker initial="leaf" name="Mina" />);
    expect(screen.getAllByRole('radio')).toHaveLength(CUSTOMER_AVATAR_KEYS.length + 1);
    const checked = container.querySelector('input[name="avatarKey"]:checked') as HTMLInputElement;
    expect(checked.value).toBe('leaf');
    fireEvent.click(screen.getByRole('radio', { name: /Sun/ }));
    expect((container.querySelector('input[name="avatarKey"]:checked') as HTMLInputElement).value).toBe('sun');
    fireEvent.click(screen.getByRole('radio', { name: /Initials/ }));
    expect((container.querySelector('input[name="avatarKey"]:checked') as HTMLInputElement).value).toBe('');
  });
});

describe('SignedInAs', () => {
  it('shows who is signed in, with a masked login, linking to the profile', () => {
    render(<SignedInAs profile={profile} labels={labels} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/loyalty/dashboard/profile');
    expect(link.textContent).toContain('Mina');
    expect(link.textContent).toContain('a***@example.com');
    expect(link.textContent).not.toContain('Amina Kato');
  });
  it('falls back to the account name, then to a plain label, and never breaks', () => {
    const { rerender } = render(<SignedInAs profile={{ ...profile, displayName: null }} labels={labels} />);
    expect(screen.getByRole('link').textContent).toContain('Amina Kato');
    rerender(<SignedInAs profile={null} labels={labels} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Customer')).toBeInTheDocument();
    rerender(<SignedInAs profile={{ ...profile, displayName: null, fullName: null }} labels={labels} />);
    expect(screen.getByText('Customer')).toBeInTheDocument();
  });
});
