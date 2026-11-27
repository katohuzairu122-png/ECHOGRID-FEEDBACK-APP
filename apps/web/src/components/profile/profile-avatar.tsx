import type { CustomerAvatarKey } from '@echo-grid-feedback/shared-types';
import { AVATAR_STYLE } from './avatar-catalogue';
import { initialsOf } from '@/lib/profile-identity';

/**
 * A round avatar: the chosen built-in glyph, or the person's initials when none is chosen. Decorative by default (the name
 * is always shown beside it); pass `label` where the avatar stands alone.
 */
export function ProfileAvatar({
  avatarKey,
  name,
  size = 40,
  label,
}: {
  avatarKey: CustomerAvatarKey | null;
  name: string | null;
  size?: number;
  label?: string;
}) {
  const style = avatarKey ? AVATAR_STYLE[avatarKey] : null;
  const common = {
    width: size,
    height: size,
    className: 'shrink-0 rounded-full',
    ...(label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const }),
  };
  if (style) {
    return (
      <svg viewBox="0 0 24 24" {...common} style={{ background: style.bg }}>
        <g transform="translate(3.6 3.6) scale(0.7)" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {style.glyph}
        </g>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" {...common} style={{ background: '#64748b' }}>
      <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize="10" fontWeight="600" fontFamily="system-ui, sans-serif">
        {initialsOf(name)}
      </text>
    </svg>
  );
}
