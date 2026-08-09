import { ImageResponse } from 'next/og';
import { PwaIconMark } from '@/lib/pwa-icon-mark';

/**
 * 192x192 PWA icon, referenced from manifest.ts -- Chrome's installability
 * check requires an icon >=192px alongside one >=512px (pwa-icon-512).
 * Separate from icon.tsx/apple-icon.tsx, which cover the browser favicon and
 * Apple touch icon respectively; this pair exists purely for the manifest.
 */
export async function GET() {
  return new ImageResponse(<PwaIconMark canvasSize={192} />, { width: 192, height: 192 });
}
