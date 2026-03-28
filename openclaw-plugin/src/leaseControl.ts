import type {
  AutomaticLeaseManagementUpdate,
  LeaseControlAPI,
  LeaseControlResult,
} from './types.js'
import type { OpenClawLeaseTelemetryService } from './service.js'

export class LeaseManagerController implements LeaseControlAPI {
  constructor(private readonly service: OpenClawLeaseTelemetryService) {}

  status(input?: { refresh?: boolean }): Promise<LeaseControlResult> {
    return this.service.getLeaseStatus(input?.refresh ?? true)
  }

  ensure(input?: { reason?: string }): Promise<LeaseControlResult> {
    return this.service.ensureLeaseNow(input?.reason)
  }

  renew(input?: { reason?: string }): Promise<LeaseControlResult> {
    return this.service.renewLeaseNow(input?.reason)
  }

  rotate(input?: { reason?: string }): Promise<LeaseControlResult> {
    return this.service.rotateLeaseNow(input?.reason)
  }

  release(input?: { reason?: string }): Promise<LeaseControlResult> {
    return this.service.releaseLeaseNow(input?.reason)
  }

  reacquire(input?: { reason?: string }): Promise<LeaseControlResult> {
    return this.service.reacquireLeaseNow(input?.reason)
  }

  materialize(): Promise<LeaseControlResult> {
    return this.service.materializeCurrentLeaseNow()
  }

  flushTelemetry(): Promise<LeaseControlResult> {
    return this.service.flushTelemetryNow()
  }

  setAutoMode(input: AutomaticLeaseManagementUpdate): Promise<LeaseControlResult> {
    return this.service.setAutomaticLeaseManagement(input)
  }
}

export function createLeaseManagerController(service: OpenClawLeaseTelemetryService): LeaseManagerController {
  return new LeaseManagerController(service)
}
