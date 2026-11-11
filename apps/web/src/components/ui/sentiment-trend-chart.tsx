import type { SentimentTrendPointDto } from '@echo-grid-feedback/shared-types';

interface SentimentTrendChartProps {
  points: SentimentTrendPointDto[];
  labels: {
    empty: string;
    ariaLabel: string;
    positive: string;
    neutral: string;
    negative: string;
  };
}

// Theme-aware series colors: the workspace scope remaps success/danger and supplies a neutral that stays
// legible on dark panels; outside a workspace they resolve to the original palette.
const SERIES = {
  positive: 'var(--color-success)',
  neutral: 'var(--ws-chart-neutral, var(--color-neutral-300))',
  negative: 'var(--color-danger)',
} as const;
const CHART_HEIGHT = 160;
const BAR_GAP = 2;

/**
 * Hand-rolled SVG stacked bar chart, not a charting library dependency --
 * at the analytics API's own capped range (30 days default, 366 max), this
 * is a genuinely simple visualization (up to ~366 bars, 3 stacked segments
 * each, no zoom/pan/tooltip interactivity needed for a first version).
 * Reconsider a real charting library only if a future block needs richer
 * interaction that would make hand-rolled SVG more effort than it's worth.
 * viewBox is a 0-100 coordinate space so bar x/width can be plain
 * percentages of the point count; preserveAspectRatio="none" lets the
 * container's own width (h-40 w-full below) control real rendered size.
 */
export function SentimentTrendChart({ points, labels }: SentimentTrendChartProps) {
  if (points.length === 0) {
    return <p className="py-8 text-center text-sm text-neutral-500">{labels.empty}</p>;
  }

  const maxTotal = Math.max(1, ...points.map((p) => p.positive + p.neutral + p.negative));
  const barWidth = 100 / points.length;
  const scale = (n: number) => (n / maxTotal) * CHART_HEIGHT;

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 100 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-40 w-full"
        role="img"
        aria-label={labels.ariaLabel}
      >
        {points.map((point, i) => {
          const x = i * barWidth + BAR_GAP / 2;
          const w = Math.max(0, barWidth - BAR_GAP);
          const negH = scale(point.negative);
          const neuH = scale(point.neutral);
          const posH = scale(point.positive);

          return (
            <g key={point.bucket}>
              <rect
                x={x}
                y={CHART_HEIGHT - negH}
                width={w}
                height={negH}
                style={{ fill: SERIES.negative }}
              />
              <rect
                x={x}
                y={CHART_HEIGHT - negH - neuH}
                width={w}
                height={neuH}
                style={{ fill: SERIES.neutral }}
              />
              <rect
                x={x}
                y={CHART_HEIGHT - negH - neuH - posH}
                width={w}
                height={posH}
                style={{ fill: SERIES.positive }}
              />
            </g>
          );
        })}
      </svg>
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>{points[0]?.bucket}</span>
        <span>{points[points.length - 1]?.bucket}</span>
      </div>
      <div className="flex items-center justify-center gap-4 text-xs text-neutral-600">
        <ChartLegendItem color={SERIES.positive} label={labels.positive} />
        <ChartLegendItem color={SERIES.neutral} label={labels.neutral} />
        <ChartLegendItem color={SERIES.negative} label={labels.negative} />
      </div>
    </div>
  );
}

function ChartLegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
