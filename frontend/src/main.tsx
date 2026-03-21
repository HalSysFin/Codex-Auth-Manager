import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type UsageTracking = {
  usage_limit: number | null
  usage_in_window: number | null
  lifetime_used: number | null
  rate_limit_refresh_at: string | null
}

type Account = {
  label: string
  account_key: string
  display_label: string | null
  email: string | null
  is_current: boolean
  usage_tracking: UsageTracking | null
}

type AccountsResponse = {
  accounts: Account[]
  current_label: string | null
}

const jsonHeaders = (token: string) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})

async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(path, { headers: jsonHeaders(token) })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(body || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

async function apiPost<T>(path: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const payload = await res.text()
    throw new Error(payload || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

function App() {
  const [apiKey, setApiKey] = useState(localStorage.getItem('auth_manager_api_key') ?? '')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [currentLabel, setCurrentLabel] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const accountCount = useMemo(() => accounts.length, [accounts])

  useEffect(() => {
    localStorage.setItem('auth_manager_api_key', apiKey)
  }, [apiKey])

  const loadAccounts = async () => {
    setLoading(true)
    setError(null)
    try {
      const payload = await apiGet<AccountsResponse>('/api/accounts', apiKey)
      setAccounts(payload.accounts)
      setCurrentLabel(payload.current_label)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (apiKey) {
      void loadAccounts()
    }
  }, [])

  const onImportCurrent = async () => {
    setMessage(null)
    setError(null)
    setBusyLabel('__global__')
    try {
      const result = await apiPost<{ label?: string; account_key?: string }>('/auth/import-current', apiKey, {})
      setMessage(`Imported auth to ${result.label ?? 'profile'} (${result.account_key ?? 'unknown key'})`)
      await loadAccounts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBusyLabel(null)
    }
  }

  const onStartAdd = async () => {
    setMessage(null)
    setError(null)
    setBusyLabel('__global__')
    try {
      const result = await apiPost<{ auth_url?: string }>('/auth/login/start', apiKey, {})
      if (result.auth_url) {
        window.open(result.auth_url, '_blank', 'noopener,noreferrer')
      }
      setMessage('Login started. Complete auth in the opened tab, then use refresh.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start login')
    } finally {
      setBusyLabel(null)
    }
  }

  const onSwitch = async (label: string) => {
    setMessage(null)
    setError(null)
    setBusyLabel(label)
    try {
      await apiPost('/auth/switch', apiKey, { label })
      setMessage(`Switched to ${label}`)
      await loadAccounts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Switch failed')
    } finally {
      setBusyLabel(null)
    }
  }

  const onDelete = async (label: string) => {
    if (!window.confirm(`Delete ${label}?`)) {
      return
    }
    setMessage(null)
    setError(null)
    setBusyLabel(label)
    try {
      await apiPost('/auth/delete', apiKey, { label })
      setMessage(`Deleted ${label}`)
      await loadAccounts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setBusyLabel(null)
    }
  }

  const onRename = async (oldLabel: string) => {
    const newLabel = window.prompt('New profile label', oldLabel)?.trim()
    if (!newLabel || newLabel === oldLabel) {
      return
    }
    setMessage(null)
    setError(null)
    setBusyLabel(oldLabel)
    try {
      await apiPost('/auth/rename', apiKey, { old_label: oldLabel, new_label: newLabel })
      setMessage(`Renamed ${oldLabel} -> ${newLabel}`)
      await loadAccounts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setBusyLabel(null)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Codex Auth Manager</h1>
        <div className="toolbar">
          <button onClick={() => void onStartAdd()} disabled={!apiKey || busyLabel !== null}>Add Account</button>
          <button onClick={() => void onImportCurrent()} disabled={!apiKey || busyLabel !== null}>Import Current</button>
          <button onClick={() => void loadAccounts()} disabled={!apiKey || loading || busyLabel !== null}>Refresh</button>
        </div>
      </header>

      <section className="panel">
        <label htmlFor="api-key">Internal API token</label>
        <input
          id="api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste INTERNAL_API_TOKEN"
        />
      </section>

      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="notice error">{error}</div> : null}

      <section className="panel">
        <div className="panel-title">
          <h2>Saved Profiles</h2>
          <span>{accountCount} accounts</span>
        </div>
        {loading ? <p>Loading...</p> : null}
        {!loading && accounts.length === 0 ? <p>No accounts found.</p> : null}
        <div className="table">
          {accounts.map((account) => {
            const usage = account.usage_tracking
            const usageText = usage
              ? `${usage.usage_in_window ?? 0}/${usage.usage_limit ?? 0}`
              : 'No data'

            return (
              <div className="row" key={`${account.account_key}:${account.label}`}>
                <div>
                  <strong>{account.display_label || account.label}</strong>
                  <div>{account.email || 'email unavailable'}</div>
                  <code>{account.account_key}</code>
                </div>
                <div>{usageText}</div>
                <div>{usage?.rate_limit_refresh_at ? new Date(usage.rate_limit_refresh_at).toLocaleString() : '--'}</div>
                <div className="actions">
                  <button onClick={() => void onSwitch(account.label)} disabled={busyLabel !== null || account.is_current}>
                    {account.is_current || account.label === currentLabel ? 'Current' : 'Switch'}
                  </button>
                  <button onClick={() => void onRename(account.label)} disabled={busyLabel !== null}>Rename</button>
                  <button onClick={() => void onDelete(account.label)} disabled={busyLabel !== null}>Delete</button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
