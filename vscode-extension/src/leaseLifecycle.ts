export {
  deriveLeaseHealthState,
  needsReacquire,
  secondsUntilExpiry,
  selectStartupAction,
  shouldReacquireAfterLookupError,
  shouldRenewLease,
  shouldRotateLease,
} from '../../packages/lease-runtime/src/leaseLifecycle.js'

import type { LeaseStatusResponse } from '../../packages/lease-runtime/src/types.js'

export type { LeaseAction, LeaseHealthState } from '../../packages/lease-runtime/src/types.js'

export function shouldRematerializeAuth(
  leaseId: string | null,
  status: Pick<LeaseStatusResponse, 'auth_refresh_required'>,
): boolean {
  return Boolean(leaseId && status.auth_refresh_required)
}
