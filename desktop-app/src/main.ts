import './styles.css'
import { createInitialPersistedState } from './state'
import { loadPersistedState } from './bridge'
import { DesktopLeaseController } from './controller'
import { DesktopAppView } from './ui'

async function main(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app')
  if (!root) {
    throw new Error('Missing app root')
  }
  const existing = await loadPersistedState()
  const initialState = createInitialPersistedState(existing)
  const view = new DesktopAppView(root)
  const controller = new DesktopLeaseController(initialState, view)
  view.attach(controller)
  view.render(controller.getSnapshot())
  await controller.initialize()
}

void main()
