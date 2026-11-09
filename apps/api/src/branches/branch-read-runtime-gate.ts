/**
 * Gate 2 B4-04: deliberate compile-time OFF barrier for the proposed
 * branch-read restricted broker. This module is NOT a feature toggle.
 *
 * The existing GET /branches/:id path must retain legacy behavior while the
 * B4-01 HMAC-shaped adapter, B4-02 disposable HMAC broker and B4-03 Ed25519
 * issuer are incompatible and no limited Hyperdrive runtime login exists.
 *
 * Never use environment variables, HTTP headers, request query parameters,
 * runtime secrets or a cast to turn on the broker. A separate reviewed code
 * change is required to replace the barrier after protocol certification.
 */
import { AppError } from '../lib/errors';

export type B4BranchReadPath = 'existing-route';

/**
 * Any attempt by future callers to request the broker path fails closed.
 * Passing 'broker' does not create a capability. No SQL is issued.
 */
export function selectB4BranchReadPath(requested: 'existing-route' | 'broker' = 'existing-route'): B4BranchReadPath {
  if (requested !== 'existing-route') {
    throw new AppError(
      'Restricted branch-read broker is not certified or available.',
      503,
      'B4_BROKER_NOT_CERTIFIED',
    );
  }
  return 'existing-route';
}
