import { describe, expect, it } from 'vitest';
import { communityPilotRequirement, COMMUNITY_PILOT_CONTROL_KEY } from './community-pilot-eligibility';
import { platformRoleHasCommunityPermission } from '../platform/community-permissions';

describe('Community pilot mode binding', () => {
  it('is off only when absent or exactly "false"', () => {
    expect(communityPilotRequirement()).toBe('not_required');
    expect(communityPilotRequirement({})).toBe('not_required');
    expect(communityPilotRequirement({ [COMMUNITY_PILOT_CONTROL_KEY]: 'false' })).toBe('not_required');
  });
  it('requires eligibility for "true" and fails closed (stricter) for every other value', () => {
    for (const value of ['true', 'TRUE', 'False', ' false', '', 'yes', '0', 1, 0, false, true, null]) {
      expect(communityPilotRequirement({ [COMMUNITY_PILOT_CONTROL_KEY]: value }), String(value)).toBe('required');
    }
  });
  it('does not read the Feed flag or any enrollment gate', () => {
    expect(communityPilotRequirement({ NETWORK_FEED_ENABLED: 'false', COMMUNITY_MEMBERSHIP_JOIN_ENABLED: 'true' } as never)).toBe('not_required');
  });
});

describe('Community pilot management authority', () => {
  it('belongs to platform admins only: support and billing roles cannot change eligibility', () => {
    expect(platformRoleHasCommunityPermission('admin', 'community:pilot')).toBe(true);
    expect(platformRoleHasCommunityPermission('support', 'community:pilot')).toBe(false);
    expect(platformRoleHasCommunityPermission('billing', 'community:pilot')).toBe(false);
  });
});
