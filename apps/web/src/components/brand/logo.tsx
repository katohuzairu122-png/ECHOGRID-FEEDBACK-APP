import { cn } from '@/lib/utils';

export interface LogoMarkProps {
  className?: string | undefined;
  size?: number | undefined;
  /** No gradient/color -- a single currentColor stroke and fill, for
   * contexts that can't render (or shouldn't rely on) a gradient: the
   * favicon/app-icon renders (Phase 4), and anywhere `mono` variant below
   * is used. */
  monochrome?: boolean;
  /** White-on-transparent, for the app icon's solid-fill treatment and any
   * other spot needing the mark as a flat cutout rather than outlined. */
  inverted?: boolean;
  gradientId?: string;
}

/**
 * The Echo Grid mark on its own: a speech-bubble outline (rounded corners,
 * thin stroke, teal-to-emerald gradient on the stroke only -- never a fill
 * gradient, per the brand guide's "flat, no glossy effects" rule) framing a
 * small connected-node graph (feedback -> AI/insight, the product's actual
 * function). `gradientId` must be unique per render when multiple marks
 * appear on one page (e.g. nav + footer) -- SVG gradient defs are ID-scoped
 * to the whole document, not per-element.
 */
export function LogoMark({
  className,
  size = 32,
  monochrome = false,
  inverted = false,
  gradientId = 'echo-grid-logo-gradient',
}: LogoMarkProps) {
  const strokeColor = monochrome ? 'currentColor' : `url(#${gradientId})`;
  const nodeFill = inverted ? '#ffffff' : monochrome ? 'currentColor' : undefined;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      className={cn('shrink-0', className)}
      aria-hidden="true"
    >
      {!monochrome && (
        <defs>
          <linearGradient id={gradientId} x1="4" y1="4" x2="36" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#06b6d4" />
            <stop offset="1" stopColor="#10b981" />
          </linearGradient>
        </defs>
      )}
      {/* Speech-bubble outline with a small tail, bottom-left -- rounded
          corners and a thin (2px at this viewBox scale) stroke, per the
          brand guide's minimal/flat/hidden-grid geometry. */}
      <path
        d="M20 5C11.716 5 5 10.82 5 18c0 4.09 2.176 7.74 5.59 10.128L9 34l6.46-3.23C16.87 30.905 18.404 31 20 31c8.284 0 15-5.82 15-13S28.284 5 20 5Z"
        stroke={strokeColor}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Small connected-node graph inside the bubble -- 5 nodes, lines
          drawn first so they sit behind the node circles. */}
      <g stroke={monochrome ? 'currentColor' : '#0f172a'} strokeOpacity={monochrome ? 1 : 0.35} strokeWidth="1.25">
        <line x1="14" y1="15" x2="20" y2="12" />
        <line x1="20" y1="12" x2="26" y2="15" />
        <line x1="14" y1="15" x2="16.5" y2="21" />
        <line x1="26" y1="15" x2="23.5" y2="21" />
        <line x1="16.5" y1="21" x2="23.5" y2="21" />
      </g>
      <g fill={nodeFill}>
        <circle cx="20" cy="12" r="2.4" fill={nodeFill ?? '#06b6d4'} />
        <circle cx="14" cy="15" r="2.4" fill={nodeFill ?? '#22d3ee'} />
        <circle cx="26" cy="15" r="2.4" fill={nodeFill ?? '#34d399'} />
        <circle cx="16.5" cy="21" r="2.4" fill={nodeFill ?? '#10b981'} />
        <circle cx="23.5" cy="21" r="2.4" fill={nodeFill ?? '#059669'} />
      </g>
    </svg>
  );
}

export interface LogoProps {
  /**
   * full: icon + wordmark + tagline + "An INFINICUS Company" -- low-density
   *   screens only (auth pages), per the brand guide's hierarchy rule that
   *   INFINICUS attribution must never compete with Echo Grid on
   *   every-page-load surfaces.
   * horizontal: icon + wordmark, no tagline/INFINICUS line -- the app
   *   header/nav default.
   * icon: mark only, no text -- tight spaces.
   * mono: single-color (currentColor) icon + wordmark, for contexts that
   *   can't/shouldn't render the gradient or brand colors (print, some
   *   email clients, favicon source).
   * dark: full lockup with light text/mono-light mark, for dark
   *   backgrounds (OG image, dark marketing sections) -- a color variant,
   *   not an app-wide dark theme.
   */
  variant?: 'full' | 'horizontal' | 'icon' | 'mono' | 'dark';
  className?: string | undefined;
  iconSize?: number | undefined;
}

const TAGLINE = 'Every Voice Drives Better Decisions.';

export function Logo({ variant = 'horizontal', className, iconSize = 32 }: LogoProps) {
  if (variant === 'icon') {
    return <LogoMark size={iconSize} className={className} />;
  }

  const isDark = variant === 'dark';
  const isMono = variant === 'mono';

  const wordmark = (
    // No explicit font-* class needed: --font-sans (globals.css) already
    // resolves to Poppins first, and this inherits the page default.
    <span className={cn('text-xl font-bold leading-none', isDark && 'text-white')}>
      <span className={isMono ? 'text-current' : isDark ? 'text-white' : 'text-neutral-900'}>Echo</span>{' '}
      <span className={isMono ? 'text-current' : isDark ? 'text-brand-400' : 'text-brand-600'}>Grid</span>
    </span>
  );

  if (variant === 'horizontal' || isMono) {
    return (
      <span className={cn('inline-flex items-center gap-2', className)}>
        <LogoMark size={iconSize} monochrome={isMono} />
        {wordmark}
      </span>
    );
  }

  // full / dark: icon + wordmark stacked above tagline + INFINICUS line.
  return (
    <span className={cn('inline-flex flex-col items-start gap-2', className)}>
      <span className="inline-flex items-center gap-2">
        <LogoMark size={iconSize} />
        {wordmark}
      </span>
      <span className={cn('text-sm', isDark ? 'text-neutral-300' : 'text-neutral-600')}>
        {TAGLINE.split(/(Voice|Better Decisions\.)/).map((part, i) =>
          part === 'Voice' || part === 'Better Decisions.' ? (
            <span key={i} className={isDark ? 'text-brand-400' : 'text-brand-600'}>
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </span>
      <span className={cn('text-xs', isDark ? 'text-neutral-400' : 'text-neutral-500')}>
        An{' '}
        <span className={cn('font-semibold', isDark ? 'text-brand-400' : 'text-brand-600')}>INFINICUS</span>{' '}
        Company
      </span>
    </span>
  );
}
