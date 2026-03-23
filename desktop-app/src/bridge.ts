import { invoke } from '@tauri-apps/api/core'
import type { AuthPayload, PersistedDesktopState } from '../../packages/lease-runtime/src/types.ts'

export interface AuthFileWriteResult {
  path: string
  writtenAt: string
}

export async function loadPersistedState(): Promise<PersistedDesktopState | null> {
  return invoke<PersistedDesktopState | null>('load_persisted_state')
}

export async function savePersistedState(state: PersistedDesktopState): Promise<void> {
  await invoke('save_persisted_state', { state })
}

export async function authFileExists(authFilePath: string): Promise<boolean> {
  return invoke<boolean>('auth_file_exists', { authFilePath })
}

export async function readAuthFile(authFilePath: string): Promise<AuthPayload | null> {
  return invoke<AuthPayload | null>('read_auth_file', { authFilePath })
}

export async function writeAuthFile(authFilePath: string, payload: AuthPayload): Promise<AuthFileWriteResult> {
  return invoke<AuthFileWriteResult>('write_auth_file', { authFilePath, payload })
}

export async function appendLogLine(message: string): Promise<void> {
  await invoke('append_log_line', { message })
}

export async function readRecentLogLines(limit = 100): Promise<string[]> {
  return invoke<string[]>('read_recent_log_lines', { limit })
}

export async function openTarget(target: string): Promise<void> {
  await invoke('open_target', { target })
}
