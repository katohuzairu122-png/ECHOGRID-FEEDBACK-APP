import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

/**
 * Favicon, generated via Next's file-convention ImageResponse route (real
 * PNG, not a static asset to maintain by hand). Simplified 3-dot version of
 * the full logo mark's node graph -- the full 5-node graph is illegible at
 * 32x32, so this trims to the minimum that still reads as "connected nodes"
 * at favicon scale.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#10b981',
          borderRadius: 7,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="6" cy="8" r="2.2" fill="#ffffff" />
          <circle cx="14" cy="8" r="2.2" fill="#ffffff" />
          <circle cx="10" cy="14" r="2.2" fill="#ffffff" />
          <line x1="6" y1="8" x2="10" y2="14" stroke="#ffffff" strokeWidth="1.2" strokeOpacity="0.7" />
          <line x1="14" y1="8" x2="10" y2="14" stroke="#ffffff" strokeWidth="1.2" strokeOpacity="0.7" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
