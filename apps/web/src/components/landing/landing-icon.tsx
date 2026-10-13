import type { SVGProps } from 'react';
import { FeedbackIcon, InsightsIcon, LoyaltyIcon } from '@/components/brand';

export type LandingIconName =
  | 'qr'
  | 'star'
  | 'chat'
  | 'chart'
  | 'bell'
  | 'shield'
  | 'store'
  | 'users'
  | 'gift'
  | 'settings'
  | 'bed'
  | 'scissors'
  | 'medical'
  | 'bag'
  | 'fitness'
  | 'arrow'
  | 'play'
  | 'check';
const paths: Partial<Record<LandingIconName, string>> = {
  qr: 'M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h2v2h-2z M19 15h2v6h-4v-2h-2 M12 3v3 M12 9v3H3 M9 12v3 M12 18v3 M15 12h6',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z M8 12l3 3 5-6',
  store:
    'M3 10v11h18V10 M2 10l2-7h16l2 7 M2 10c0 4 5 4 5 0 0 4 5 4 5 0 0 4 5 4 5 0 0 4 5 4 5 0 M8 21v-7h8v7',
  users:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M2 21v-2a7 7 0 0 1 14 0v2z M16 4a4 4 0 0 1 0 7 M18 14a5 5 0 0 1 4 5v2h-3',
  gift: 'M3 10h18v4H3z M5 14v7h14v-7 M12 10v11 M12 10C3 10 3 2 7 3c3 0 5 7 5 7 0 0 2-7 5-7 4-1 4 7-5 7',
  settings:
    'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  bed: 'M3 21V8 M21 21V11H3v7h18 M6 11V5h12v6 M3 18h18',
  scissors:
    'M9 8 21 21 M9 16 21 3 M3 3a4 4 0 1 0 4 4 4 4 0 0 0-4-4 M3 13a4 4 0 1 0 4 4 4 4 0 0 0-4-4',
  medical: 'M8 3h8v5h5v8h-5v5H8v-5H3V8h5z',
  bag: 'M4 7h16l1 14H3z M8 8V6a4 4 0 0 1 8 0v2',
  fitness: 'M2 8v8 M5 5v14 M19 5v14 M22 8v8 M5 12h14',
  arrow: 'M4 12h16 M14 6l6 6-6 6',
  play: 'M9 6v12l10-6z',
  check: 'M5 12l4 4L19 6',
};
export function LandingIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: LandingIconName }) {
  if (name === 'chat') return <FeedbackIcon {...props} />;
  if (name === 'chart') return <InsightsIcon {...props} />;
  if (name === 'star') return <LoyaltyIcon {...props} />;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
