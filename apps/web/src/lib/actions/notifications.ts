'use server';

import { revalidatePath } from 'next/cache';
import type {
  MaterializedNotificationPreferenceDto,
  BusinessNotificationSettingsDto,
  NotificationEventType,
  NotificationChannel,
} from '@echo-grid-feedback/shared-types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getActiveBusiness } from '@/lib/business';

const NOTIFICATIONS_PATH = '/dashboard/notifications';

// ---- Self-service preferences (no permission required) --------------------

/**
 * Called imperatively with an already-built array, not via useActionState +
 * FormData -- the payload is a nested array ({eventType, channel, enabled}[]),
 * which raw FormData parsing represents poorly. Same "typed direct call,
 * useTransition for pending state" shape as loyalty's
 * toggleRewardStatusAction, not the form-action pattern used where the
 * payload is flat fields (see updateNotificationSettingsAction below).
 */
export async function updateNotificationPreferencesAction(
  preferences: Array<{ eventType: NotificationEventType; channel: NotificationChannel; enabled: boolean }>,
): Promise<MaterializedNotificationPreferenceDto[]> {
  const business = await getActiveBusiness();
  if (!business) throw new Error('No active business.');

  const result = await apiFetch<MaterializedNotificationPreferenceDto[]>('/notifications/preferences', {
    method: 'PATCH',
    businessId: business.id,
    body: JSON.stringify({ preferences }),
  });
  revalidatePath(NOTIFICATIONS_PATH);
  return result;
}

// ---- Business-wide settings (notifications:manage) -------------------------

export interface NotificationSettingsFormState {
  error?: string;
  success?: boolean;
}

/**
 * Flat fields (two booleans, one number) map cleanly onto FormData, so this
 * keeps the useActionState + <form action> pattern SettingsForm (loyalty)
 * already established, unlike the preferences grid above. A Staff member
 * without notifications:manage will get the API's 403 back as
 * `err.message` here -- this app has no client-side permission-hiding
 * anywhere yet (every module relies on the API to enforce and the form to
 * surface the resulting error), so this stays consistent with that existing
 * pattern rather than introducing a one-off exception for this module.
 */
export async function updateNotificationSettingsAction(
  _prevState: NotificationSettingsFormState,
  formData: FormData,
): Promise<NotificationSettingsFormState> {
  const business = await getActiveBusiness();
  if (!business) return { error: 'No active business.' };

  try {
    await apiFetch<BusinessNotificationSettingsDto>('/notifications/settings', {
      method: 'PATCH',
      businessId: business.id,
      body: JSON.stringify({
        emailEnabled: formData.get('emailEnabled') === 'on',
        smsEnabled: formData.get('smsEnabled') === 'on',
        maxSmsPerDay: Number(formData.get('maxSmsPerDay')),
      }),
    });
  } catch (err) {
    if (err instanceof ApiError) return { error: err.message };
    return { error: 'Something went wrong. Please try again.' };
  }

  revalidatePath(NOTIFICATIONS_PATH);
  return { success: true };
}
