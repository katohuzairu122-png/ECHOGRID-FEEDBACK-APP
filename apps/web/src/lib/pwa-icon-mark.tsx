/**
 * Shared brand mark for the two PWA manifest icon routes (pwa-icon-192,
 * pwa-icon-512) -- same emerald-background, white node-graph treatment as
 * apple-icon.tsx, just parameterized by canvas size so the two routes don't
 * each carry their own copy of this SVG.
 */
export function PwaIconMark({ canvasSize }: { canvasSize: number }) {
  const markSize = Math.round(canvasSize * 0.6);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#10b981',
      }}
    >
      <svg width={markSize} height={markSize} viewBox="0 0 40 40" fill="none">
        <path
          d="M20 5C11.716 5 5 10.82 5 18c0 4.09 2.176 7.74 5.59 10.128L9 34l6.46-3.23C16.87 30.905 18.404 31 20 31c8.284 0 15-5.82 15-13S28.284 5 20 5Z"
          stroke="#ffffff"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <g stroke="#ffffff" strokeOpacity="0.6" strokeWidth="1.25">
          <line x1="14" y1="15" x2="20" y2="12" />
          <line x1="20" y1="12" x2="26" y2="15" />
          <line x1="14" y1="15" x2="16.5" y2="21" />
          <line x1="26" y1="15" x2="23.5" y2="21" />
          <line x1="16.5" y1="21" x2="23.5" y2="21" />
        </g>
        <g fill="#ffffff">
          <circle cx="20" cy="12" r="2.4" />
          <circle cx="14" cy="15" r="2.4" />
          <circle cx="26" cy="15" r="2.4" />
          <circle cx="16.5" cy="21" r="2.4" />
          <circle cx="23.5" cy="21" r="2.4" />
        </g>
      </svg>
    </div>
  );
}
