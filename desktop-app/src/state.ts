import {
  defaultRuntimeLeaseState,
  defaultRuntimeSettings,
  deriveAgentId,
  deriveMachineId,
} from '../../packages/lease-runtime/src/runtimeState.ts'
import type { PersistedDesktopState, RuntimeLeaseState, RuntimeSettings } from '../../packages/lease-runtime/src/types.ts'

export function createInitialPersistedState(existing: PersistedDesktopState | null): PersistedDesktopState {
  const baseSettings: RuntimeSettings = {
    ...defaultRuntimeSettings(),
    ...(existing?.settings || {}),
  }
  const machineId = deriveMachineId(baseSettings.machineId)
  const agentId = deriveAgentId(baseSettings.agentId)
  const settings: RuntimeSettings = {
    ...baseSettings,
    machineId,
    agentId,
  }
  const lease: RuntimeLeaseState = {
    ...defaultRuntimeLeaseState(machineId, agentId, settings.authFilePath),
    ...(existing?.lease || {}),
    machineId,
    agentId,
    authFilePath: settings.authFilePath,
  }
  return { settings, lease }
}
