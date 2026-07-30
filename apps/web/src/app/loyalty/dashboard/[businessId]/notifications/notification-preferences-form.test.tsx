import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { NotificationPreferencesForm } from './notification-preferences-form';
import { updateNotificationPreferencesAction } from '@/lib/actions/loyalty-customer';
import {
  CUSTOMER_NOTIFICATION_EVENT_TYPES,
  DELIVERABLE_NOTIFICATION_CHANNELS,
  type MaterializedNotificationPreferenceDto,
} from '@echo-grid-feedback/shared-types';

vi.mock('@/lib/actions/loyalty-customer', () => ({
  updateNotificationPreferencesAction: vi.fn(),
}));

const BUSINESS_ID = 'business-1';

function allEnabled(): MaterializedNotificationPreferenceDto[] {
  return CUSTOMER_NOTIFICATION_EVENT_TYPES.flatMap((eventType) =>
    DELIVERABLE_NOTIFICATION_CHANNELS.map((channel) => ({ eventType, channel, enabled: true })),
  );
}

describe('NotificationPreferencesForm (customer)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one checkbox per event type x channel, checked according to the preferences prop', () => {
    const preferences = allEnabled();
    preferences[0] = { ...preferences[0]!, enabled: false }; // points_earned/email off

    render(
      <NotificationPreferencesForm
        businessId={BUSINESS_ID}
        eventTypes={CUSTOMER_NOTIFICATION_EVENT_TYPES}
        channels={DELIVERABLE_NOTIFICATION_CHANNELS}
        preferences={preferences}
      />,
    );

    expect(screen.getByRole('checkbox', { name: 'Email notifications for Points earned' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'SMS notifications for Points earned' })).toBeChecked();
  });

  it('saves against the given businessId, including an in-progress toggle', async () => {
    const user = userEvent.setup();
    vi.mocked(updateNotificationPreferencesAction).mockResolvedValue(allEnabled());

    render(
      <NotificationPreferencesForm
        businessId={BUSINESS_ID}
        eventTypes={CUSTOMER_NOTIFICATION_EVENT_TYPES}
        channels={DELIVERABLE_NOTIFICATION_CHANNELS}
        preferences={allEnabled()}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'SMS notifications for Tier upgraded' }));
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => expect(updateNotificationPreferencesAction).toHaveBeenCalled());
    const [calledBusinessId, payload] = vi.mocked(updateNotificationPreferencesAction).mock.calls[0]!;
    expect(calledBusinessId).toBe(BUSINESS_ID);
    const toggled = payload.find((p) => p.eventType === 'tier_upgraded' && p.channel === 'sms');
    expect(toggled?.enabled).toBe(false);
  });

  it('surfaces a failed save with an inline error instead of failing silently', async () => {
    const user = userEvent.setup();
    vi.mocked(updateNotificationPreferencesAction).mockRejectedValue(new Error('network error'));

    render(
      <NotificationPreferencesForm
        businessId={BUSINESS_ID}
        eventTypes={CUSTOMER_NOTIFICATION_EVENT_TYPES}
        channels={DELIVERABLE_NOTIFICATION_CHANNELS}
        preferences={allEnabled()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save preferences');
  });
});
