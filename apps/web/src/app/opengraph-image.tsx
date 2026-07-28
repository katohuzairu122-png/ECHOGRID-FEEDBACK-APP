import { ImageResponse } from 'next/og';
import { socialImageContent } from './_social-image';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(socialImageContent(), { ...size });
}
