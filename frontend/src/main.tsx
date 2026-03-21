import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type LimitShape = {
  percent?: number | null
  usedPercent?: number | null
  remaining?: number | null
  limit?: number | null
  reset?: string | null
  resetsAt?: string | null
  resetAt?: string | null
  nextResetAt?: string | null
}

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
  rate_limits?: {
    requests?: LimitShape | null
    tokens?: LimitShape | null
    primary?: LimitShape | null
    secondary?: LimitShape | null
    error?: string
  }
  usage_tracking: UsageTracking | null
}

type AccountsResponse = {
  accounts: Account[]
  current_label: string | null
}

type PublicStatsResponse = {
  accounts_managed?: number
  profiles_with_tokens?: number
  auth_file?: { modified_at?: string | null }
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

function parsePercent(limit: LimitShape | null | undefined): number | null {
  if (!limit) return null
  const raw = limit.percent ?? limit.usedPercent
  if (typeof raw !== 'number' || Number.isNaN(raw)) return null
  return Math.min(100, Math.max(0, Math.round(raw)))
}

function formatReset(limit: LimitShape | null | undefined): string {
  if (!limit) return '--'
  const raw = limit.resetsAt ?? limit.resetAt ?? limit.nextResetAt ?? limit.reset
  if (!raw) return '--'
  if (typeof raw !== 'string') return String(raw)
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleString()
}

function percentClass(value: number): string {
  if (value > 85) return 'danger'
  if (value > 60) return 'warn'
  return 'ok'
}

function App() {
  const [apiKey, setApiKey] = useState(localStorage.getItem('auth_manager_api_key') ?? '')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [currentLabel, setCurrentLabel] = useState<string | null>(null)
  const [publicStats, setPublicStats] = useState<PublicStatsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [openMenuLabel, setOpenMenuLabel] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')

  const accountCount = accounts.length
  const profilesWithToken =
    publicStats?.profiles_with_tokens ??
    accounts.filter((a) => {
      const p = parsePercent(a.rate_limits?.primary ?? a.rate_limits?.requests)
      const s = parsePercent(a.rate_limits?.secondary ?? a.rate_limits?.tokens)
      return p !== null || s !== null
    }).length

  useEffect(() => {
    localStorage.setItem('auth_manager_api_key', apiKey)
  }, [apiKey])

  const loadPublicStats = async () => {
    try {
      const payload = await fetch('/api/public-stats').then((r) => r.json() as Promise<PublicStatsResponse>)
      setPublicStats(payload)
    } catch {
      setPublicStats(null)
    }
  }

  const loadAccounts = async () => {
    if (!apiKey.trim()) {
      setAccounts([])
      setCurrentLabel(null)
      return
    }
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

  const refreshAll = async () => {
    await Promise.all([loadPublicStats(), loadAccounts()])
  }

  useEffect(() => {
    void loadPublicStats()
    if (apiKey.trim()) void loadAccounts()
  }, [])

  const onSaveToken = async () => {
    setMessage(null)
    setError(null)
    await refreshAll()
  }

  const onClearToken = async () => {
    setApiKey('')
    localStorage.removeItem('auth_manager_api_key')
    setAccounts([])
    setCurrentLabel(null)
    setMessage(null)
    setError(null)
    await loadPublicStats()
  }

  const onImportCurrent = async () => {
    setMessage(null)
    setError(null)
    setBusyLabel('__global__')
    try {
      const result = await apiPost<{ label?: string; account_key?: string }>('/auth/import-current', apiKey, {})
      setMessage(`Imported auth to ${result.label ?? 'profile'} (${result.account_key ?? 'unknown key'})`)
      await refreshAll()
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
      const result = await apiPost<{ auth_url?: string; instructions?: string }>('/auth/login/start', apiKey, {})
      if (result.auth_url) window.open(result.auth_url, '_blank', 'noopener,noreferrer')
      setMessage(result.instructions || 'Login started. Complete auth in opened tab then refresh.')
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
    setOpenMenuLabel(null)
    try {
      await apiPost('/auth/switch', apiKey, { label })
      setMessage(`Switched to ${label}`)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Switch failed')
    } finally {
      setBusyLabel(null)
    }
  }

  const onDelete = async (label: string) => {
    if (!window.confirm(`Delete ${label}?`)) return
    setMessage(null)
    setError(null)
    setBusyLabel(label)
    setOpenMenuLabel(null)
    try {
      await apiPost('/auth/delete', apiKey, { label })
      setMessage(`Deleted ${label}`)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setBusyLabel(null)
    }
  }

  const onExport = async (label: string) => {
    setOpenMenuLabel(null)
    try {
      const payload = await apiGet<{ auth_json: unknown; label: string }>('/auth/export?label=' + encodeURIComponent(label), apiKey)
      const blob = new Blob([JSON.stringify(payload.auth_json, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${label}.auth.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    }
  }

  const openEditModal = (label: string) => {
    setOpenMenuLabel(null)
    setEditLabel(label)
    setNewLabel(label)
  }

  const onSaveRename = async () => {
    if (!editLabel || !newLabel.trim() || newLabel.trim() === editLabel) {
      setEditLabel(null)
      return
    }
    setBusyLabel(editLabel)
    try {
      await apiPost('/auth/rename', apiKey, { old_label: editLabel, new_label: newLabel.trim() })
      setMessage(`Renamed ${editLabel} -> ${newLabel.trim()}`)
      setEditLabel(null)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed')
    } finally {
      setBusyLabel(null)
    }
  }

  const aggregate = useMemo(() => {
    if (!accounts.length) return { p: 0, s: 0, recommended: null as Account | null }
    let sumP = 0
    let sumS = 0
    let best = accounts[0]
    let bestScore = Number.POSITIVE_INFINITY
    for (const a of accounts) {
      const p = parsePercent(a.rate_limits?.primary ?? a.rate_limits?.requests) ?? 0
      const s = parsePercent(a.rate_limits?.secondary ?? a.rate_limits?.tokens) ?? 0
      sumP += p
      sumS += s
      if (p + s < bestScore) {
        bestScore = p + s
        best = a
      }
    }
    return {
      p: Math.round(sumP / accounts.length),
      s: Math.round(sumS / accounts.length),
      recommended: best,
    }
  }, [accounts])

  return (
    <>
      <nav className="navbar">
        <div className="nav-brand">
          <span className="dot" />
          Auth Manager
        </div>
        <div className="nav-actions">
          <button className="btn btn-primary" onClick={() => void onStartAdd()} disabled={!apiKey || busyLabel !== null}>
            Add Account
          </button>
          <button className="btn" onClick={() => void onImportCurrent()} disabled={!apiKey || busyLabel !== null}>
            Import Current
          </button>
          <a className="btn" href="/ui/stats">Overall Stats</a>
          <button className="btn btn-icon" onClick={() => void refreshAll()} disabled={loading || busyLabel !== null}>↻</button>
        </div>
      </nav>

      <div className="page">
        <div className="token-bar">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter your API bearer token to unlock account management..."
          />
          <button className="btn btn-primary btn-sm" onClick={() => void onSaveToken()}>
            Apply
          </button>
          <button className="btn btn-sm" onClick={() => void onClearToken()}>
            Clear
          </button>
        </div>

        {message ? <div className="status-note ok">{message}</div> : null}
        {error ? <div className="status-note warn">{error}</div> : null}

        <div className="two-col">
          <aside className="sidebar">
            <div className="panel">
              <div className="panel-title">System Overview</div>
              <div className="kv-list">
                <div className="kv-item">
                  <div className="kv-label">Accounts Managed</div>
                  <div className="kv-value">{publicStats?.accounts_managed ?? accountCount}</div>
                </div>
                <div className="kv-item">
                  <div className="kv-label">Profiles with Token</div>
                  <div className="kv-value">{profilesWithToken}</div>
                </div>
                <div className="kv-item">
                  <div className="kv-label">Auth File Updated</div>
                  <div className="kv-value small">{publicStats?.auth_file?.modified_at ? new Date(publicStats.auth_file.modified_at).toLocaleString() : '--'}</div>
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">Aggregated Usage</div>
              <div className="metric-line">
                <span>Cluster 5hr Usage</span>
                <strong>{aggregate.p}%</strong>
              </div>
              <div className="bar-track"><div className={`bar-fill ${percentClass(aggregate.p)}`} style={{ width: `${aggregate.p}%` }} /></div>
              <div className="metric-sub">{Math.max(0, 100 - aggregate.p)}% remaining across cluster</div>

              <div className="metric-line" style={{ marginTop: 12 }}>
                <span>Cluster 7d Usage</span>
                <strong>{aggregate.s}%</strong>
              </div>
              <div className="bar-track"><div className={`bar-fill ${percentClass(aggregate.s)}`} style={{ width: `${aggregate.s}%` }} /></div>
              <div className="metric-sub">{Math.max(0, 100 - aggregate.s)}% remaining across cluster</div>

              <div className="kv-item" style={{ marginTop: 14 }}>
                <div className="kv-label">Recommended Profile</div>
                <button
                  className="btn btn-sm"
                  onClick={() => (aggregate.recommended ? void onSwitch(aggregate.recommended.label) : undefined)}
                  disabled={!aggregate.recommended || busyLabel !== null}
                >
                  Switch to {aggregate.recommended?.display_label || aggregate.recommended?.label || '--'}
                </button>
              </div>
            </div>
          </aside>

          <main>
            <div className="panel panel-main">
              <div className="panel-head">
                <div className="panel-title">Saved Profiles</div>
                <span className="pill">{accountCount} accounts</span>
              </div>

              <div className="accounts-table-head">
                <div>Profile</div>
                <div>Rate Limits</div>
                <div>Rate Limit Reset</div>
                <div>Actions</div>
              </div>

              {loading ? <div className="empty">Loading...</div> : null}
              {!loading && !accounts.length ? <div className="empty">No accounts found.</div> : null}

              {accounts.map((account) => {
                const primary = account.rate_limits?.requests ?? account.rate_limits?.primary
                const secondary = account.rate_limits?.tokens ?? account.rate_limits?.secondary
                const p = parsePercent(primary)
                const s = parsePercent(secondary)
                return (
                  <div className="account-row" key={`${account.account_key}:${account.label}`}>
                    <div>
                      <div className="acct-name">
                        {account.display_label || account.label}
                        {(account.is_current || account.label === currentLabel) && <span className="pill active">Current</span>}
                      </div>
                      <div className="acct-email">{account.email || 'email unavailable'}</div>
                      <div className="acct-label">Profile label: {account.label}</div>
                    </div>

                    <div>
                      {account.rate_limits?.error ? (
                        <div className="rate-error">{account.rate_limits.error}</div>
                      ) : (
                        <>
                          <div className="limit-row">
                            <span>5HR</span>
                            <div className="bar-track"><div className={`bar-fill ${percentClass(p ?? 0)}`} style={{ width: `${p ?? 0}%` }} /></div>
                            <strong>{p ?? '--'}%</strong>
                          </div>
                          <div className="limit-row">
                            <span>7D</span>
                            <div className="bar-track"><div className={`bar-fill ${percentClass(s ?? 0)}`} style={{ width: `${s ?? 0}%` }} /></div>
                            <strong>{s ?? '--'}%</strong>
                          </div>
                        </>
                      )}
                    </div>

                    <div>
                      <div className="reset-line">{formatReset(primary)}</div>
                      <div className="reset-line">{formatReset(secondary)}</div>
                    </div>

                    <div className="actions-menu-wrap">
                      <button className="btn btn-sm" onClick={() => setOpenMenuLabel(openMenuLabel === account.label ? null : account.label)}>
                        Actions ▾
                      </button>
                      {openMenuLabel === account.label && (
                        <div className="actions-menu">
                          <button className="menu-item" onClick={() => void onSwitch(account.label)} disabled={busyLabel !== null}>
                            {account.is_current || account.label === currentLabel ? 'Switch (Current)' : 'Switch'}
                          </button>
                          <button className="menu-item" onClick={() => openEditModal(account.label)} disabled={busyLabel !== null}>
                            Change profile label
                          </button>
                          <button className="menu-item" onClick={() => void onExport(account.label)} disabled={busyLabel !== null}>
                            Export
                          </button>
                          <button className="menu-item danger" onClick={() => void onDelete(account.label)} disabled={busyLabel !== null}>
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </main>
        </div>
      </div>

      {editLabel && (
        <div className="modal-backdrop" onClick={() => setEditLabel(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Edit Profile Name</div>
            <div className="modal-sub">Change the saved profile label used by switch/export operations.</div>
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={64} autoFocus />
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setEditLabel(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={() => void onSaveRename()}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
