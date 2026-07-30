/**
 * Shared JSX for opengraph-image.tsx and twitter-image.tsx -- both are
 * 1200x630 renders of the same lockup, so the markup lives once here.
 * Deliberately does NOT fetch Poppins as a custom satori font (the
 * documented risk: Cloudflare Workers edge + network font-fetch
 * reliability for a route that must never hard-fail) -- uses
 * ImageResponse's built-in fallback font instead.
 */
export function socialImageContent() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        background: '#0f172a',
      }}
    >
      <div
        style={{
          display: 'flex',
          width: 96,
          height: 96,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 20,
          background: '#10b981',
        }}
      >
        <svg width="60" height="60" viewBox="0 0 40 40" fill="none">
          <path
            d="M20 5C11.716 5 5 10.82 5 18c0 4.09 2.176 7.74 5.59 10.128L9 34l6.46-3.23C16.87 30.905 18.404 31 20 31c8.284 0 15-5.82 15-13S28.284 5 20 5Z"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div style={{ display: 'flex', fontSize: 76, fontWeight: 700 }}>
        <span style={{ color: '#ffffff' }}>Echo</span>
        <span style={{ color: '#34d399', marginLeft: 20 }}>Grid</span>
      </div>
      <div style={{ display: 'flex', fontSize: 28, color: '#cbd5e1' }}>Every Voice Drives Better Decisions.</div>
      <div style={{ display: 'flex', fontSize: 20, color: '#94a3b8' }}>An INFINICUS Company</div>
    </div>
  );
}
