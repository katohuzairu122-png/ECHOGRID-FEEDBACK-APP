import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CustomerProgrammeCardDto } from '@echo-grid-feedback/shared-types';
import { renderWithIntl as render } from '@/test-utils';
import { CustomerProgrammeCard } from './customer-programme-card';

const reward = '6f0f1c5e-0000-4000-8000-000000000001';
const base = { currency: 'USD', earnedRewards: [] as CustomerProgrammeCardDto['earnedRewards'] };
const names = { [reward]: 'Free coffee' };

describe('CustomerProgrammeCard (LPC-07)', () => {
  it('shows nothing for a points programme with no rewards waiting', () => {
    const { container } = render(<CustomerProgrammeCard card={{ ...base, programme: { type: 'LP-03', view: { kind: 'points', type: 'LP-03' }, rewardNames: {} } }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing when the business has no active programme and nothing is waiting', () => {
    const { container } = render(<CustomerProgrammeCard card={{ ...base, programme: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('LP-01 shows stamps, the reward name and the expiry', () => {
    render(<CustomerProgrammeCard card={{ ...base, programme: { type: 'LP-01', rewardNames: names, view: { kind: 'stamps', stamps: 2, threshold: 5, rewardId: reward, completedCards: 1, expiresAt: '2026-07-01T00:00:00.000Z', expired: false, fraction: 0.4 } } }} />);
    expect(screen.getByText('2 of 5 stamps')).toBeInTheDocument();
    expect(screen.getByText('Complete the card to earn: Free coffee')).toBeInTheDocument();
    expect(screen.getByText(/Stamps valid until/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });

  it('LP-04 lists the ladder with earned and not-yet steps', () => {
    render(<CustomerProgrammeCard card={{ ...base, programme: { type: 'LP-04', rewardNames: names, view: { kind: 'milestones', metric: 'purchases', current: '3', fraction: 0.5, ladder: [{ threshold: '3', rewardId: reward, achieved: true }, { threshold: '6', rewardId: reward, achieved: false }] } } }} />);
    expect(screen.getByText('3 qualifying purchases so far')).toBeInTheDocument();
    expect(screen.getByText('Earned')).toBeInTheDocument();
    expect(screen.getByText('Not yet')).toBeInTheDocument();
  });

  it('LP-05 shows the streak', () => {
    render(<CustomerProgrammeCard card={{ ...base, programme: { type: 'LP-05', rewardNames: names, view: { kind: 'streak', period: 'week', streak: 3, required: 4, gracePeriods: 1, rewardId: reward, completedStreaks: 0, fraction: 0.75 } } }} />);
    expect(screen.getByText('3 of 4 weeks in a row')).toBeInTheDocument();
    expect(screen.getByText(/You can miss up to 1 week/)).toBeInTheDocument();
  });

  it('LP-06 lists the public off-peak windows', () => {
    render(<CustomerProgrammeCard card={{ ...base, programme: { type: 'LP-06', rewardNames: {}, view: { kind: 'offpeak', windows: [{ days: [1, 2], start: '14:00', end: '16:00', multiplier: '2' }], effectiveFrom: null, effectiveUntil: null } } }} />);
    expect(screen.getByText(/Mon, Tue · 14:00–16:00 · 2× points/)).toBeInTheDocument();
  });

  it('LP-07 shows each mission with its status', () => {
    render(<CustomerProgrammeCard card={{ ...base, programme: { type: 'LP-07', rewardNames: names, view: { kind: 'missions', missions: [
      { key: 'a', objective: 'purchases', target: '3', current: '1', status: 'active', endsAt: '2026-06-18T00:00:00.000Z', rewardId: reward, fraction: 1 / 3 },
      { key: 'b', objective: 'spend', target: '50.00', current: '25.00', status: 'completed', endsAt: null, rewardId: reward, fraction: 1 },
    ] } } }} />);
    expect(screen.getByText('1 of 3 purchases')).toBeInTheDocument();
    expect(screen.getByText('25.00 of 50.00 USD spent')).toBeInTheDocument();
    expect(screen.getAllByText(/Reward: Free coffee/)).toHaveLength(2);
  });

  it('shows rewards waiting for the cashier, by name only', () => {
    render(<CustomerProgrammeCard card={{ ...base, programme: null, earnedRewards: [{ rewardName: 'Free coffee', expiresAt: null }] }} />);
    expect(screen.getByTestId('earned-waiting')).toHaveTextContent('Free coffee');
    expect(screen.getByText('Rewards waiting for you')).toBeInTheDocument();
  });
});
