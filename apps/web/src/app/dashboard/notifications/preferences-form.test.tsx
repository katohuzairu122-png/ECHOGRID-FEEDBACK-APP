import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { PreferencesForm } from './preferences-form';
import { updateNotificationPreferencesAction } from '@/lib/actions/notifications';
import {
  STAFF_NOTIFICATION_EVENT_TYPES,
  DELIVERABLE_NOTIFICATION_CHANNELS,
  type MaterializedNotificationPreferenceDto,
} from '@echo-grid-feedback/shared-types';

vi.mock('@/lib/actions/notifications', () => ({
  updateNotificationPreferencesAction: vi.fn(),
}));

function allEnabled(): MaterializedNotificationPreferenceDto[] {
  return STAFF_NOTIFICATION_EVENT_TYPES.flatMap((eventType) =>
    DELIVERABLE_NOTIFICATION_CHANNELS.map((channel) => ({ eventType, channel, enabled: true })),
  );
}

describe('PreferencesForm (staff)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one checkbox per event type x channel, checked according to the preferences prop', () => {
    const preferences = allEnabled();
    preferences[0] = { ...preferences[0]!, enabled: false }; // feedback_received/email off

    render(
      <PreferencesForm
        eventTypes={STAFF_NOTIFICATION_EVENT_TYPES}
        channels={DELIVERABLE_NOTIFICATION_CHANNELS}
        preferences={preferences}
      />,
    );

    expect(
      screen.getByRole('checkbox', { name: 'Email notifications for New feedback received' }),
    ).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'SMS notifications for New feedback received' })).toBeChecked();
  });

  it('saves the current grid state, including an in-progress toggle, when Save is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(updateNotificationPreferencesAction).mockResolvedValue(allEnabled());

    render(
      <PreferencesForm
        eventTypes={STAFF_NOTIFICATION_EVENT_TYPES}
        channels={DELIVERABLE_NOTIFICATION_CHANNELS}
        preferences={allEnabled()}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'Email notifications for AI summary ready' }));
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    await waitFor(() => expect(updateNotificationPreferencesAction).toHaveBeenCalled());
    const payload = vi.mocked(updateNotificationPreferencesAction).mock.calls[0]![0];
    const toggled = payload.find((p) => p.eventType === 'summary_ready' && p.channel === 'email');
    expect(toggled?.enabled).toBe(false);
  });

  it('shows a confirmation after a successful save', async () => {
    const user = userEvent.setup();
    vi.mocked(updateNotificationPreferencesAction).mockResolvedValue(allEnabled());

    render(
      <PreferencesForm
        eventTypes={STAFF_NOTIFICATION_EVENT_TYPES}
        channels={DELIVERABLE_NOTIFICATION_CHANNELS}
        preferences={allEnabled()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(await screen.findByText('Preferences saved.')).toBeInTheDocument();
  });

  it('surfaces a failed save with an inline error instead of failing silently', async () => {
    const user = userEvent.setup();
    vi.mocked(updateNotificationPreferencesAction).mockRejectedValue(new Error('network error'));

    render(
      <PreferencesForm
        eventTypes={STAFF_NOTIFICATION_EVENT_TYPES}
        channels={DELIVERABLE_NOTIFICATION_CHANNELS}
        preferences={allEnabled()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save preferences' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save preferences');
  });
});
