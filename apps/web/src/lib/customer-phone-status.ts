import 'server-only';
import { customerApiFetch } from './customer-api-client';

export interface PhoneStatusDto {
  /** The number on file, masked, or null. Never the number itself. */
  phoneMasked: string | null;
  verified: boolean;
}

/** Read-only status of the signed-in customer's phone. Server components only (not a Server Action). */
export async function getPhoneStatus(): Promise<PhoneStatusDto> {
  return customerApiFetch<PhoneStatusDto>('/loyalty/me/phone', { cache: 'no-store' }, '/loyalty/dashboard/phone');
}
