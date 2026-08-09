import { ImageResponse } from 'next/og';
import { PwaIconMark } from '@/lib/pwa-icon-mark';

/** 512x512 counterpart to pwa-icon-192 -- see that file's doc comment. */
export async function GET() {
  return new ImageResponse(<PwaIconMark canvasSize={512} />, { width: 512, height: 512 });
}
