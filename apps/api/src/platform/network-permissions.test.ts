import { describe, expect, it } from 'vitest';
import { NETWORK_PLATFORM_PERMISSIONS, platformRoleHasNetworkPermission } from './network-permissions';

describe('Network platform permission matrix', () => {
  it.each(NETWORK_PLATFORM_PERMISSIONS)('only the platform admin holds %s', (permission) => {
    expect(platformRoleHasNetworkPermission('admin', permission)).toBe(true);
    expect(platformRoleHasNetworkPermission('support', permission)).toBe(false);
    expect(platformRoleHasNetworkPermission('billing', permission)).toBe(false);
  });
});
