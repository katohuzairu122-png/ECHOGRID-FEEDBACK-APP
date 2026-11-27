import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';

vi.mock('@/lib/actions/loyalty-programmes', () => ({ programmeAction: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ProgrammeCards, type RegistryCard } from './programme-cards';
import { ProgrammeForm } from './programme-form';
import { ActiveProgrammePanel, OtherProgrammesPanel } from './programme-panels';

const registry: RegistryCard[] = [
  ...(['LP-01', 'LP-02', 'LP-03', 'LP-04', 'LP-05', 'LP-06', 'LP-07'] as const).map((type) => ({ type, available: true })),
  { type: 'LP-08', available: false, unavailableReason: 'NEEDS_ITEM_LEVEL_EVIDENCE' as const },
];
const rewards = [{ id: '6f0f1c5e-0000-4000-8000-0000000000a1', name: 'Free coffee' }];

describe('programme selector cards', () => {
  it('shows one card for each of the eight programmes', () => {
    render(<ProgrammeCards registry={registry} />);
    expect(screen.getAllByTestId(/^programme-card-LP-0[1-8]$/)).toHaveLength(8);
  });
  it('available programmes can be selected; LP-08 has no select action and says why', () => {
    render(<ProgrammeCards registry={registry} setup />);
    const lp03 = screen.getByTestId('programme-card-LP-03');
    expect(within(lp03).getByRole('link', { name: 'Select' })).toHaveAttribute('href', '/dashboard/loyalty/programme?type=LP-03&setup=1#configure');
    const lp08 = screen.getByTestId('programme-card-LP-08');
    expect(within(lp08).queryByRole('link')).toBeNull();
    expect(within(lp08).getByText('Not available')).toBeVisible();
    expect(within(lp08).getByRole('note')).toHaveTextContent(/item-level purchase data/i);
  });
  it('marks the current programme and offers Edit instead of Select', () => {
    render(<ProgrammeCards registry={registry} activeType="LP-02" />);
    const card = screen.getByTestId('programme-card-LP-02');
    expect(within(card).getByText('Current')).toBeVisible();
    expect(within(card).getByRole('link', { name: 'Edit' })).toBeVisible();
  });
  it('gives every programme an example and its requirements', () => {
    render(<ProgrammeCards registry={registry} />);
    expect(screen.getByText('Example: every 1 KWD spent earns 10 points.')).toBeVisible();
    expect(screen.getByText(/Needs: points per currency unit/)).toBeVisible();
  });
});

describe('each programme has its OWN configuration form', () => {
  const open = (type: Parameters<typeof ProgrammeForm>[0]['type'], config: Record<string, unknown> = {}, extra: Partial<Parameters<typeof ProgrammeForm>[0]> = {}) =>
    render(<ProgrammeForm type={type} config={config} rewards={rewards} currency="KWD" {...extra} />);

  it('LP-03: points per currency unit, with the business currency in the label', () => {
    open('LP-03');
    expect(screen.getByLabelText(/Points per .*spent/)).toBeVisible();
    expect(screen.queryByLabelText('Stamps per card')).toBeNull();
  });
  it('LP-02: fixed points and an optional minimum, with check-in points shown as a separate setting', () => {
    open('LP-02');
    expect(screen.getByLabelText('Points per qualifying purchase')).toBeVisible();
    expect(screen.getByLabelText(/Minimum purchase/)).toBeVisible();
    expect(screen.getByLabelText(/Points per check-in/)).toBeVisible();
  });
  it('LP-01: stamps, a free-item reward and a REQUIRED explicit expiry choice', async () => {
    open('LP-01');
    expect(screen.getByLabelText('Stamps per card')).toHaveValue('5');
    expect(screen.getByLabelText('Free item reward')).toBeRequired();
    expect(screen.getByRole('option', { name: 'Free coffee' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Days after the first stamp')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Stamp expiry'), 'days');
    expect(screen.getByLabelText('Days after the first stamp')).toBeRequired();
    expect(screen.getByText(/starts a new card from zero/)).toBeVisible();
  });
  it('LP-04: milestone rows can be added and removed, and the screen says milestones are not tiers', async () => {
    open('LP-04');
    expect(screen.getByText(/not membership tiers/i)).toBeVisible();
    expect(screen.getAllByLabelText(/Milestone \d+: threshold/)).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Add milestone' }));
    expect(screen.getAllByLabelText(/Milestone \d+: threshold/)).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Remove last' }));
    expect(screen.getAllByLabelText(/Milestone \d+: threshold/)).toHaveLength(1);
  });
  it('LP-05: period, periods in a row, grace and the business-timezone note', () => {
    open('LP-05');
    expect(screen.getByLabelText('Periods in a row')).toBeVisible();
    expect(screen.getByLabelText('Missed periods allowed')).toBeVisible();
    expect(screen.getByText('Days and weeks use your business timezone.')).toBeVisible();
  });
  it('LP-06: weekday checkboxes, local start and end times, and a statement that a cashier cannot change eligibility', () => {
    open('LP-06');
    expect(screen.getByRole('group', { name: /Days for window 1/ })).toBeVisible();
    expect(screen.getByLabelText('From')).toHaveValue('14:00');
    expect(screen.getByText(/a cashier cannot change it/)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Mon' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Sat' })).not.toBeChecked();
  });
  it('LP-07: mission rows with a goal, target, deadline and reward, and no rating or review goal offered', () => {
    open('LP-07');
    expect(screen.getByLabelText('Mission name')).toBeVisible();
    expect(screen.getByLabelText('Days to complete')).toBeVisible();
    const goals = within(screen.getByLabelText('Goal')).getAllByRole('option').map((o) => o.textContent);
    expect(goals.join(' ')).not.toMatch(/rating|review|feedback/i);
  });
  it('warns when there is no prize reward to choose from', () => {
    render(<ProgrammeForm type="LP-04" config={{}} rewards={[]} currency="USD" />);
    expect(screen.getByRole('note')).toHaveTextContent(/Create an active free-item, discount or voucher reward first/);
  });
  it('requires an explicit confirmation and explains what stays, what changes and what needs consent', () => {
    open('LP-03', {}, { replaces: 'Fixed points per purchase' });
    const activation = screen.getByRole('group', { name: 'Before you activate' });
    expect(within(activation).getByText(/points balance, past transactions, earned rewards, tiers/)).toBeVisible();
    expect(within(activation).getByText(/never rewritten/)).toBeVisible();
    expect(within(activation).getByText(/not converted/)).toBeVisible();
    expect(within(activation).getByText('This will replace the active programme: Fixed points per purchase.')).toBeVisible();
    expect(within(activation).getByRole('checkbox')).not.toBeChecked();
    expect(within(activation).getByText(/Only the business Owner/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Validate and activate' })).toBeVisible();
  });
  it('an unavailable type renders no form', () => {
    render(<ProgrammeForm type="LP-08" config={{}} rewards={rewards} currency="USD" />);
    expect(screen.getByRole('status')).toBeVisible();
  });
});

describe('programme management panels', () => {
  const base = { id: 'p1', type: 'LP-03' as const, status: 'active' as const, currentVersion: 3, legacy: false, config: {}, activatedAt: '2026-11-20T10:00:00Z', deactivatedAt: null, createdAt: '2026-11-01T10:00:00Z' };
  it('shows a clear notice when no programme is active (Configure Later)', () => {
    render(<ActiveProgrammePanel active={undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent(/earn nothing until you activate a programme/);
  });
  it('shows the active programme, its version and status, and flags a legacy programme', () => {
    render(<ActiveProgrammePanel active={{ ...base, legacy: true }} />);
    expect(screen.getByText('Spend and earn')).toBeVisible();
    expect(screen.getByText('Active')).toBeVisible();
    expect(screen.getByText('Existing earning rules')).toBeVisible();
    expect(screen.getByText('3')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Edit configuration' })).toHaveAttribute('href', '/dashboard/loyalty/programme?edit=p1#configure');
    expect(screen.getByRole('button', { name: 'Pause programme' })).toBeVisible();
  });
  it('lists drafts, validated and paused programmes with the right actions, and hides active and retired ones', () => {
    render(<OtherProgrammesPanel programmes={[
      { ...base, id: 'd', type: 'LP-02', status: 'draft' }, { ...base, id: 'v', type: 'LP-04', status: 'validated' }, { ...base, id: 'i', type: 'LP-05', status: 'inactive' },
      { ...base, id: 'a' }, { ...base, id: 'r', type: 'LP-06', status: 'retired' },
    ]} />);
    expect(screen.getByText('Fixed points per purchase')).toBeVisible();
    expect(screen.getByText('Milestone rewards')).toBeVisible();
    expect(screen.getByText('Streak rewards')).toBeVisible();
    expect(screen.queryByText('Off-peak rewards')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Retire' })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Validate and activate' })).toHaveLength(1); // only the validated one
  });
  it('renders nothing when there are no other programmes', () => {
    const { container } = render(<OtherProgrammesPanel programmes={[{ ...base }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
