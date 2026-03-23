import { deriveMachineId, deriveAgentId } from '../../packages/lease-runtime/src/runtimeState.ts'
import type { LeaseHealthState, RuntimeSettings } from '../../packages/lease-runtime/src/types.ts'
import type { ControllerSnapshot, DesktopLeaseController } from './controller'

function fmt(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return 'Unavailable'
  }
  return String(value)
}

function titleForState(state: LeaseHealthState): string {
  switch (state) {
    case 'active':
      return 'Active'
    case 'expiring':
      return 'Expiring'
    case 'rotation_required':
      return 'Rotation Required'
    case 'revoked':
      return 'Revoked'
    case 'backend_unavailable':
      return 'Backend Unavailable'
    default:
      return 'No Lease'
  }
}

export class DesktopAppView {
  private controller: DesktopLeaseController | null = null

  constructor(private readonly root: HTMLElement) {
    this.root.innerHTML = `
      <div class="shell">
        <header class="hero">
          <div>
            <p class="eyebrow">Broker-Managed Codex Auth</p>
            <h1>Auth Manager Desktop</h1>
          </div>
          <div id="healthPill" class="pill no_lease">No Lease</div>
        </header>
        <section class="panel settings">
          <div class="panel-head">
            <h2>Settings</h2>
            <button id="saveSettings">Save Settings</button>
          </div>
          <div class="form-grid">
            <label>Backend Base URL<input id="baseUrl" /></label>
            <label>Internal API Token<input id="internalApiToken" type="password" /></label>
            <label>Machine ID<input id="machineId" /></label>
            <label>Agent ID<input id="agentId" /></label>
            <label>Auth File Path<input id="authFilePath" /></label>
            <label>Dashboard Path<input id="openDashboardPath" /></label>
            <label>Refresh Interval Seconds<input id="refreshIntervalSeconds" type="number" min="15" /></label>
            <label>Telemetry Interval Seconds<input id="telemetryIntervalSeconds" type="number" min="60" /></label>
            <label class="check"><input id="autoRenew" type="checkbox" />Auto Renew</label>
            <label class="check"><input id="autoRotate" type="checkbox" />Auto Rotate</label>
            <label class="check"><input id="allowInsecureLocalhost" type="checkbox" />Allow HTTP on localhost</label>
          </div>
        </section>
        <section class="actions">
          <button data-action="ensure">Ensure Lease</button>
          <button data-action="refresh">Refresh Lease</button>
          <button data-action="renew">Renew Lease</button>
          <button data-action="rotate">Rotate Lease</button>
          <button data-action="release">Release Lease</button>
          <button data-action="rewriteAuth">Rewrite Auth File</button>
          <button data-action="openDashboard">Open Dashboard</button>
          <button data-action="openAuthLocation">Open Auth File Location</button>
        </section>
        <section id="message" class="message hidden"></section>
        <section class="grid" id="details"></section>
        <section class="panel logs">
          <div class="panel-head">
            <h2>Recent Log</h2>
          </div>
          <pre id="logLines"></pre>
        </section>
      </div>
    `
    this.root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
      button.addEventListener('click', () => this.dispatchAction(button.dataset.action || ''))
    })
    this.root.querySelector<HTMLButtonElement>('#saveSettings')?.addEventListener('click', () => this.saveSettings())
  }

  attach(controller: DesktopLeaseController): void {
    this.controller = controller
  }

  render(snapshot: ControllerSnapshot): void {
    const pill = this.root.querySelector<HTMLElement>('#healthPill')
    if (pill) {
      pill.textContent = titleForState(snapshot.healthState)
      pill.className = `pill ${snapshot.healthState}`
    }
    const message = this.root.querySelector<HTMLElement>('#message')
    if (message) {
      message.textContent = snapshot.message || ''
      message.classList.toggle('hidden', !snapshot.message)
    }
    const details = this.root.querySelector<HTMLElement>('#details')
    if (details) {
      const state = snapshot.lease
      const rows = [
        ['Lease State', state.leaseState],
        ['Lease ID', state.leaseId],
        ['Credential ID', state.credentialId],
        ['Machine ID', state.machineId],
        ['Agent ID', state.agentId],
        ['Issued At', state.issuedAt],
        ['Expires At', state.expiresAt],
        ['Latest Utilization %', state.latestUtilizationPct],
        ['Latest Quota Remaining', state.latestQuotaRemaining],
        ['Replacement Required', state.replacementRequired],
        ['Rotation Recommended', state.rotationRecommended],
        ['Last Backend Refresh', state.lastBackendRefreshAt],
        ['Last Telemetry', state.latestTelemetryAt],
        ['Last Auth Write', state.lastAuthWriteAt],
        ['Auth File Path', state.authFilePath],
        ['Backend Base URL', snapshot.settings.baseUrl],
        ['Backend Reachable', snapshot.backendReachable],
      ]
      details.innerHTML = rows.map(([label, value]) => `
        <article class="card">
          <label>${label}</label>
          <div class="value">${fmt(value as string | number | boolean | null | undefined)}</div>
        </article>
      `).join('')
    }
    const logLines = this.root.querySelector<HTMLElement>('#logLines')
    if (logLines) {
      logLines.textContent = snapshot.logs.slice(-60).join('\n')
    }
    this.populateSettings(snapshot.settings)
  }

  private populateSettings(settings: RuntimeSettings): void {
    this.value('baseUrl', settings.baseUrl)
    this.value('internalApiToken', settings.internalApiToken)
    this.value('machineId', settings.machineId)
    this.value('agentId', settings.agentId)
    this.value('authFilePath', settings.authFilePath)
    this.value('openDashboardPath', settings.openDashboardPath)
    this.value('refreshIntervalSeconds', String(settings.refreshIntervalSeconds))
    this.value('telemetryIntervalSeconds', String(settings.telemetryIntervalSeconds))
    this.checked('autoRenew', settings.autoRenew)
    this.checked('autoRotate', settings.autoRotate)
    this.checked('allowInsecureLocalhost', settings.allowInsecureLocalhost)
  }

  private dispatchAction(action: string): void {
    if (!this.controller) {
      return
    }
    switch (action) {
      case 'ensure':
        void this.controller.ensureLease()
        break
      case 'refresh':
        void this.controller.refreshLease()
        break
      case 'renew':
        void this.controller.renewLease()
        break
      case 'rotate':
        void this.controller.rotateLease()
        break
      case 'release':
        void this.controller.releaseLease()
        break
      case 'rewriteAuth':
        void this.controller.rewriteAuthFile()
        break
      case 'openDashboard':
        void this.controller.openDashboard()
        break
      case 'openAuthLocation':
        void this.controller.openAuthFileLocation()
        break
      default:
        break
    }
  }

  private saveSettings(): void {
    if (!this.controller) {
      return
    }
    const machineId = this.inputValue('machineId')
    const agentId = this.inputValue('agentId')
    this.controller.updateSettings({
      baseUrl: this.inputValue('baseUrl'),
      internalApiToken: this.inputValue('internalApiToken'),
      machineId: deriveMachineId(machineId),
      agentId: deriveAgentId(agentId),
      authFilePath: this.inputValue('authFilePath'),
      refreshIntervalSeconds: Number(this.inputValue('refreshIntervalSeconds')) || 60,
      telemetryIntervalSeconds: Number(this.inputValue('telemetryIntervalSeconds')) || 300,
      autoRenew: this.inputChecked('autoRenew'),
      autoRotate: this.inputChecked('autoRotate'),
      openDashboardPath: this.inputValue('openDashboardPath'),
      allowInsecureLocalhost: this.inputChecked('allowInsecureLocalhost'),
    })
  }

  private inputValue(id: string): string {
    return (this.root.querySelector<HTMLInputElement>(`#${id}`)?.value || '').trim()
  }

  private inputChecked(id: string): boolean {
    return Boolean(this.root.querySelector<HTMLInputElement>(`#${id}`)?.checked)
  }

  private value(id: string, value: string): void {
    const input = this.root.querySelector<HTMLInputElement>(`#${id}`)
    if (input && input.value !== value) {
      input.value = value
    }
  }

  private checked(id: string, checked: boolean): void {
    const input = this.root.querySelector<HTMLInputElement>(`#${id}`)
    if (input) {
      input.checked = checked
    }
  }
}
