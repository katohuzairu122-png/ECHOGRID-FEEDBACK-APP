import { describe, expect, it, vi } from 'vitest';
import { HistoricalSubscriptionTierReader } from '../src/partner-credits/historical-subscription-tier.reader';

const sample = {
  businessId: 'business-1',
  stripeCustomerId: 'cus_one',
  stripeSubscriptionId: 'sub_one',
  fulfilledAt: new Date('2026-10-11T10:00:00Z'),
};
function setup(rows: Array<{ customerId: string; subscriptionId: string; eventId: string }>) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { reader: new HistoricalSubscriptionTierReader({ select } as never), select };
}
describe('Stripe historical tier evidence', () => {
  it('rejects invalid identity before reading', async () => {
    const { reader, select } = setup([]);
    expect((await reader.inspect({ ...sample, stripeCustomerId: 'invalid' })).reason).toBe('INVALID_INPUT');
    expect(select).not.toHaveBeenCalled();
  });
  it('denies missing observations', async () => {
    const outcome = await setup([]).reader.inspect(sample);
    expect(outcome).toMatchObject({reason:'NO_PROVIDER_HISTORY',issuanceAuthorized:false});
  });
  it('denies mismatched subscriptions', async () => {
    const outcome = await setup([{customerId:'cus_other',subscriptionId:'sub_other',eventId:'evt_1'}]).reader.inspect(sample);
    expect(outcome.reason).toBe('IDENTITY_MISMATCH');
  });
  it('does not claim provider effective-window proof from an event observation', async () => {
    const outcome = await setup([{customerId:'cus_one',subscriptionId:'sub_one',eventId:'evt_1'}]).reader.inspect(sample);
    expect(outcome).toMatchObject({reason:'EFFECTIVE_WINDOW_UNPROVEN',historicalTierVerified:false,issuanceAuthorized:false});
  });
});
