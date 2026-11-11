import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SentimentBreakdown } from './sentiment-breakdown';

const labels = {
  negative: 'Negative',
  neutral: 'Neutral',
  positive: 'Positive',
};
const formatCount = (value: number) => String(value);
const formatRate = (fraction: number) => `${Math.round(fraction * 100)}%`;

describe('SentimentBreakdown', () => {
  it('renders three colored categories in approved negative/neutral/positive order using only supplied counts', () => {
    render(
      <SentimentBreakdown
        totals={{ total: 10, negative: 2, neutral: 3, positive: 5 }}
        labels={labels}
        formatCount={formatCount}
        formatRate={formatRate}
      />,
    );

    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.getAttribute('data-sentiment'))).toEqual([
      'negative', 'neutral', 'positive',
    ]);
    for (const [index, label, count, share] of [
      [0, 'Negative', '2', '20%'],
      [1, 'Neutral', '3', '30%'],
      [2, 'Positive', '5', '50%'],
    ] as const) {
      const card = within(cards[index]!);
      expect(card.getByText(label)).toBeInTheDocument();
      expect(card.getByText(count)).toBeInTheDocument();
      expect(card.getByText(share)).toBeInTheDocument();
    }
  });

  it('does not present synthetic zero percentages for an empty or unavailable data set', () => {
    const { container } = render(
      <SentimentBreakdown
        totals={{ total: 0, negative: 0, neutral: 0, positive: 0 }}
        labels={labels}
        formatCount={formatCount}
        formatRate={formatRate}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('retains zero-valued sentiment categories when other classified data exists', () => {
    render(
      <SentimentBreakdown
        totals={{ total: 2, negative: 0, neutral: 0, positive: 2 }}
        labels={labels}
        formatCount={formatCount}
        formatRate={formatRate}
      />,
    );
    expect(screen.getAllByText('0%')).toHaveLength(2);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});
