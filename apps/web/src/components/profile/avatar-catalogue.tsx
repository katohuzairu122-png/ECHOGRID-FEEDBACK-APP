import type { ReactNode } from 'react';
import { CUSTOMER_AVATAR_KEYS, type CustomerAvatarKey } from '@echo-grid-feedback/shared-types';

/** How each built-in avatar key is drawn (PROF-01 owns the keys; the web app owns the artwork). Simple line glyphs on a tinted disc. */
export const AVATAR_STYLE: Record<CustomerAvatarKey, { bg: string; glyph: ReactNode }> = {
  sun: { bg: '#d97706', glyph: <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></> },
  moon: { bg: '#4f46e5', glyph: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /> },
  star: { bg: '#ca8a04', glyph: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /> },
  leaf: { bg: '#16a34a', glyph: <path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15M5 19l8-8" /> },
  wave: { bg: '#0284c7', glyph: <path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0" /> },
  flame: { bg: '#dc2626', glyph: <path d="M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z" /> },
  bolt: { bg: '#7c3aed', glyph: <path d="M13 3 5 13h6l-1 8 8-10h-6z" /> },
  heart: { bg: '#db2777', glyph: <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" /> },
  cloud: { bg: '#475569', glyph: <path d="M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 9a4.5 4.5 0 0 1 0 9z" /> },
  peak: { bg: '#0f766e', glyph: <path d="m3 19 6-11 4 7 3-4 5 8z" /> },
  bloom: { bg: '#c026d3', glyph: <><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="5.5" r="2.5" /><circle cx="12" cy="18.5" r="2.5" /><circle cx="5.5" cy="12" r="2.5" /><circle cx="18.5" cy="12" r="2.5" /></> },
  orbit: { bg: '#0369a1', glyph: <><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-30 12 12)" /><circle cx="12" cy="12" r="2.5" /></> },
};

export const AVATAR_KEYS: readonly CustomerAvatarKey[] = CUSTOMER_AVATAR_KEYS;
