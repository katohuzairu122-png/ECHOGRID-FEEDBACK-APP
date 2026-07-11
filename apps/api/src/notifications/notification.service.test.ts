import { describe, it, expect, vi } from 'vitest';
import { NotificationService, type NotifyRecipient } from './notification.service';
import type { NotificationPreference, NotificationPreferenceRepository } from '../repositories/notification-preference.repository';
import type { NotificationRepository } from '../repositories/notification.repository';
import type {
  BusinessNotificationSettings,
  BusinessNotificationSettingsRepository,
} from '../repositories/business-notification-settings.repository';
import type { User, UserRepository } from '../repositories/user.repository';
import type { Customer, CustomerRepository } from '../repositories/customer.repository';
import type { UserBusinessRole, UserBusinessRoleRepository } from '../repositories/user-business-role.repository';
import type { PermissionRepository } from '../repositories/permission.repository';
import type { SendNotificationJob } from './notification-job';
import type { NotificationTemplateData } from './notification-templates';

const BUSINESS_A = 'business-a';

function makeSettings(overrides: Partial<BusinessNotificationSettings> = {}): BusinessNotificationSettings {
  return {
    id: 'settings-1',
    businessId: BUSINESS_A,
    emailEnabled: true,
    smsEnabled: true,
    maxSmsPerDay: 50,
    updatedBy: null,
    updatedAt: new Date(),
    ...overrides,
  } as BusinessNotificationSettings;
}

interface FakeRepoOptions {
  settings?: Partial<BusinessNotificationSettings>;
  /** null = user lookup resolves to undefined (not found); omit for a
   * default user with both an email and a phone on file. */
  user?: Partial<User> | null;
  customer?: Partial<Customer> | null;
  /** The one preference row findOne() should resolve to -- undefined (the
   * default) exercises the "no row = enabled" rule. */
  preference?: NotificationPreference;
  existingPreferences?: NotificationPreference[];
  smsSentToday?: number;
  grants?: UserBusinessRole[];
  /** A single Set applies to every getEffectivePermissions() call; an array
   * is consumed one-per-call, in the order notifyBusinessStaff iterates
   * uniqueUserIds (grant order, first occurrence wins). */
  effectivePermissions?: Set<string> | Set<string>[];
}

/** Mirrors summary.service.test.ts's per-method vi.fn() factory -- chosen
 * over a full in-memory fake (like loyalty-reward.service.test.ts) because
 * NotificationService spans 7 repositories and this suite mostly needs to
 * control one return value per test, not maintain relational state across
 * calls. */
function createFakeRepos(options: FakeRepoOptions = {}) {
  const permsQueue = Array.isArray(options.effectivePermissions) ? [...options.effectivePermissions] : undefined;

  const notificationPreferences = {
    findOne: vi.fn().mockResolvedValue(options.preference),
    listForRecipient: vi.fn().mockResolvedValue(options.existingPreferences ?? []),
  } as unknown as NotificationPreferenceRepository;

  const notifications = {
    countSince: vi.fn().mockResolvedValue(options.smsSentToday ?? 0),
  } as unknown as NotificationRepository;

  const businessNotificationSettings = {
    getOrCreateDefaults: vi.fn().mockResolvedValue(makeSettings(options.settings)),
  } as unknown as BusinessNotificationSettingsRepository;

  const users = {
    findById: vi.fn().mockResolvedValue(
      options.user === null
        ? undefined
        : ({ id: 'user-1', email: 'staff@example.com', phone: '+15550001111', ...options.user } as User),
    ),
  } as unknown as UserRepository;

  const customers = {
    findById: vi.fn().mockResolvedValue(
      options.customer === null
        ? undefined
        : ({ id: 'customer-1', email: null, phone: '+15559998888', ...options.customer } as Customer),
    ),
  } as unknown as CustomerRepository;

  const userBusinessRoles = {
    listForBusiness: vi.fn().mockResolvedValue(options.grants ?? []),
  } as unknown as UserBusinessRoleRepository;

  const permissions = {
    findEffectiveKeys: vi.fn().mockImplementation(async () => {
      if (permsQueue) return permsQueue.shift() ?? new Set();
      return options.effectivePermissions ?? new Set();
    }),
  } as unknown as PermissionRepository;

  return {
    notificationPreferences,
    notifications,
    businessNotificationSettings,
    users,
    customers,
    userBusinessRoles,
    permissions,
  };
}

function createFakeQueue() {
  return { send: vi.fn().mockResolvedValue(undefined) } as unknown as Queue<SendNotificationJob>;
}

const SUMMARY_DATA: NotificationTemplateData = {
  eventType: 'summary_ready',
  businessName: 'Test Biz',
  periodLabel: 'Jul 1 - Jul 8',
};
const STAFF_RECIPIENT: NotifyRecipient = { userId: 'user-1' };

describe('NotificationService.notify', () => {
  it('enqueues to every deliverable channel the recipient has an address for, when nothing blocks delivery', async () => {
    const queue = createFakeQueue();
    const service = new NotificationService(createFakeRepos(), queue);

    await service.notify(BUSINESS_A, STAFF_RECIPIENT, SUMMARY_DATA);

    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', recipientAddress: 'staff@example.com' }),
    );
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'sms', recipientAddress: '+15550001111' }),
    );
  });

  it('skips a channel entirely when the recipient has no address for it', async () => {
    const queue = createFakeQueue();
    const repos = createFakeRepos({ user: { email: 'staff@example.com', phone: null } });
    const service = new NotificationService(repos, queue);

    await service.notify(BUSINESS_A, STAFF_RECIPIENT, SUMMARY_DATA);

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email' }));
  });

  it('skips email when the business-wide kill switch is off, even with an address on file', async () => {
    const queue = createFakeQueue();
    const repos = createFakeRepos({ settings: { emailEnabled: false } });
    const service = new NotificationService(repos, queue);

    await service.notify(BUSINESS_A, STAFF_RECIPIENT, SUMMARY_DATA);

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms' }));
  });

  it('skips sms once the daily cost cap is reached', async () => {
    const queue = createFakeQueue();
    const repos = createFakeRepos({ settings: { maxSmsPerDay: 5 }, smsSentToday: 5 });
    const service = new NotificationService(repos, queue);

    await service.notify(BUSINESS_A, STAFF_RECIPIENT, SUMMARY_DATA);

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email' }));
  });

  it('skips a channel the recipient has explicitly opted out of', async () => {
    const queue = createFakeQueue();
    const preference = {
      id: 'pref-1',
      businessId: BUSINESS_A,
      userId: 'user-1',
      customerId: null,
      eventType: 'summary_ready',
      channel: 'email',
      enabled: false,
    } as NotificationPreference;
    const repos = createFakeRepos({ preference });
    const service = new NotificationService(repos, queue);

    await service.notify(BUSINESS_A, STAFF_RECIPIENT, SUMMARY_DATA);

    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms' }));
  });

  it('treats an absent preference row as enabled -- the "no row = default" rule', async () => {
    const queue = createFakeQueue();
    const service = new NotificationService(createFakeRepos({ preference: undefined }), queue);

    await service.notify(BUSINESS_A, STAFF_RECIPIENT, SUMMARY_DATA);

    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it('throws when called with neither userId nor customerId', async () => {
    const service = new NotificationService(createFakeRepos(), createFakeQueue());

    await expect(service.notify(BUSINESS_A, {}, SUMMARY_DATA)).rejects.toThrow();
  });

  it('attempts every channel independently -- one channel failing to enqueue does not stop the other or throw', async () => {
    const queue = createFakeQueue();
    vi.mocked(queue.send).mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValueOnce(undefined);
    const service = new NotificationService(createFakeRepos(), queue);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(service.notify(BUSINESS_A, STAFF_RECIPIENT, SUMMARY_DATA)).resolves.toBeUndefined();
    expect(queue.send).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });
});

describe('NotificationService.notifyBusinessStaff', () => {
  const FEEDBACK_DATA: NotificationTemplateData = {
    eventType: 'feedback_received',
    businessName: 'Test Biz',
    branchName: 'Main St',
    rating: 5,
  };

  it('notifies every unique user with an active grant, deduping repeated grants', async () => {
    const queue = createFakeQueue();
    const grants = [
      { userId: 'user-1', businessId: BUSINESS_A } as UserBusinessRole,
      { userId: 'user-2', businessId: BUSINESS_A } as UserBusinessRole,
      { userId: 'user-1', businessId: BUSINESS_A } as UserBusinessRole, // e.g. a branch grant + a business-wide grant
    ];
    // Single deliverable channel per user (email only) keeps the assertion
    // about UNIQUE RECIPIENTS unambiguous, separate from the per-channel
    // fan-out already covered by the notify() suite above.
    const repos = createFakeRepos({ grants, user: { email: 'staff@example.com', phone: null } });
    const service = new NotificationService(repos, queue);

    await service.notifyBusinessStaff(BUSINESS_A, FEEDBACK_DATA);

    expect(queue.send).toHaveBeenCalledTimes(2);
  });

  it('filters to only users holding requiredPermission when one is given', async () => {
    const queue = createFakeQueue();
    const grants = [
      { userId: 'user-1', businessId: BUSINESS_A } as UserBusinessRole,
      { userId: 'user-2', businessId: BUSINESS_A } as UserBusinessRole,
    ];
    const repos = createFakeRepos({
      grants,
      user: { email: 'staff@example.com', phone: null },
      effectivePermissions: [new Set(['analytics:view']), new Set(['loyalty:manage'])],
    });
    const service = new NotificationService(repos, queue);

    await service.notifyBusinessStaff(BUSINESS_A, FEEDBACK_DATA, 'analytics:view');

    expect(queue.send).toHaveBeenCalledTimes(1); // only user-1 held analytics:view
  });

  it('notifies everyone, unfiltered, when requiredPermission is omitted', async () => {
    const queue = createFakeQueue();
    const grants = [
      { userId: 'user-1', businessId: BUSINESS_A } as UserBusinessRole,
      { userId: 'user-2', businessId: BUSINESS_A } as UserBusinessRole,
    ];
    const repos = createFakeRepos({ grants, user: { email: 'staff@example.com', phone: null } });
    const service = new NotificationService(repos, queue);

    await service.notifyBusinessStaff(BUSINESS_A, FEEDBACK_DATA);

    expect(queue.send).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationService.listMaterializedPreferences', () => {
  it('returns the full eventType x channel grid, defaulting to enabled when no row exists', async () => {
    const service = new NotificationService(createFakeRepos({ existingPreferences: [] }), createFakeQueue());

    const result = await service.listMaterializedPreferences(BUSINESS_A, STAFF_RECIPIENT, [
      'summary_ready',
      'feedback_received',
    ]);

    // 2 event types x 2 deliverable channels (email, sms -- push has no
    // delivery implementation, see DELIVERABLE_NOTIFICATION_CHANNELS)
    expect(result).toHaveLength(4);
    expect(result.every((r) => r.enabled === true)).toBe(true);
  });

  it('reflects an explicit disabled row instead of the default, leaving siblings at the default', async () => {
    const existingPreferences = [
      {
        eventType: 'summary_ready',
        channel: 'email',
        enabled: false,
      } as NotificationPreference,
    ];
    const service = new NotificationService(createFakeRepos({ existingPreferences }), createFakeQueue());

    const result = await service.listMaterializedPreferences(BUSINESS_A, STAFF_RECIPIENT, ['summary_ready']);

    expect(result.find((r) => r.channel === 'email')?.enabled).toBe(false);
    expect(result.find((r) => r.channel === 'sms')?.enabled).toBe(true);
  });
});
