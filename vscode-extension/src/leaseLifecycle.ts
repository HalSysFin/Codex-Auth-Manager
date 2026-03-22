import type { LeaseStatusResponse } from './authManagerClient'

export type LeaseHealthState = 'active' | 'expiring' | 'rotation_required' | 'revoked' | 'no_lease' | 'backend_unavailable'

export function secondsUntilExpiry(expiresAt: string, now = new Date()): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000))
}

export function deriveLeaseHealthState(
  lease: Pick<LeaseStatusResponse, 'state' | 'replacement_required' | 'rotation_recommended' | 'expires_at'>,
  now = new Date(),
): LeaseHealthState {
  if (lease.state === 'revoked' || lease.state === 'expired') {
    return 'revoked'
  }
  if (lease.replacement_required) {
    return 'rotation_required'
  }
  if (secondsUntilExpiry(lease.expires_at, now) <= 300) {
    return 'expiring'
  }
  if (lease.rotation_recommended) {
    return 'rotation_required'
  }
  return 'active'
}

export function shouldRenewLease(
  lease: Pick<LeaseStatusResponse, 'state' | 'expires_at' | 'replacement_required'>,
  autoRenew: boolean,
  now = new Date(),
): boolean {
  if (!autoRenew) {
    return false
  }
  if (lease.state !== 'active') {
    return false
  }
  if (lease.replacement_required) {
    return false
  }
  return secondsUntilExpiry(lease.expires_at, now) <= 300
}

export function shouldRotateLease(
  lease: Pick<LeaseStatusResponse, 'state' | 'replacement_required' | 'rotation_recommended'>,
  autoRotate: boolean,
): boolean {
  if (!autoRotate) {
    return false
  }
  if (lease.state === 'revoked' || lease.state === 'expired') {
    return true
  }
  return lease.replacement_required || lease.rotation_recommended
}

export function needsReacquire(lease: Pick<LeaseStatusResponse, 'state'> | null | undefined): boolean {
  if (!lease) {
    return true
  }
  return lease.state === 'revoked' || lease.state === 'expired'
}
