import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type RefreshStatus = {
  state?: 'idle' | 'ok' | 'failed' | 'refreshing'
  last_attempt_at?: string | null
  last_success_at?: string | null
  last_error?: string | null
  is_stale?: boolean
}

type Limit = {
  limit?: number
  used?: number
  remaining?: number
  percent?: number
  usedPercent?: number
  resetsAt?: string | number | null
  resetAt?: string | number | null
  nextResetAt?: string | number | null
  reset?: string | number | null
  windowDurationMins?: number
}

type UsageTracking = {
  usage_limit?: number
  usage_in_window?: number
  lifetime_used?: number
  rate_limit_refresh_at?: string | null
  last_usage_sync_at?: string | null
  updated_at?: string | null
}

type Account = {
  label: string
  account_key: string
  display_label: string | null
  email: string | null
  is_current: boolean
  rate_limits?: {
    primary?: Limit | null
    secondary?: Limit | null
    requests?: Limit | null
    tokens?: Limit | null
    error?: string
  }
  usage_tracking?: UsageTracking | null
  refresh_status?: RefreshStatus
}

type Aggregate = {
  accounts: number
  total_current_window_used: number
  total_current_window_limit: number
  total_remaining: number
  aggregate_utilization_percent: number
  lifetime_total_used: number
  total_wasted: number
  stale_accounts: number
  failed_accounts: number
  last_refresh_time: string | null
}

type AccountsCachedResponse = {
  accounts: Account[]
  current_label: string | null
  aggregate: Aggregate
}

type StreamSnapshot = {
  accounts: Account[]
  current_label: string | null
  aggregate: Aggregate
  pending_labels: string[]
}

type ViewMode = 'manager' | 'stats'
type AccountHistoryResponse = {
  label: string
  account_key: string
  display_label: string | null
  email: string | null
  usage_tracking?: UsageTracking | null
  rollovers: Array<{
    window_started_at?: string
    window_ended_at?: string
    usage_limit?: number
    usage_used?: number
    usage_wasted?: number
  }>
  summary?: {
    window_count?: number
    total_wasted?: number
    total_used_completed?: number
    total_limit_completed?: number
    avg_completed_utilization_percent?: number | null
    current_wasted_if_rollover_now?: number
  }
}

const defaultAggregate: Aggregate = {
  accounts: 0,
  total_current_window_used: 0,
  total_current_window_limit: 0,
  total_remaining: 0,
  aggregate_utilization_percent: 0,
  lifetime_total_used: 0,
  total_wasted: 0,
  stale_accounts: 0,
  failed_accounts: 0,
  last_refresh_time: null,
}

const SESSION_TOKEN = '__session__'
const ACTION_API_KEY_STORAGE = 'auth_manager_action_api_key'

function authHeaders(token: string): Record<string, string> {
  if (!token || token === SESSION_TOKEN) return {}
  return { Authorization: `Bearer ${token}` }
}

async function requestJson<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(token),
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const raw = await res.text()
    try {
      const d = JSON.parse(raw)
      if (typeof d.detail === 'string') throw new Error(d.detail)
      if (d.detail?.message) throw new Error(d.detail.message)
    } catch {
      throw new Error(raw || `HTTP ${res.status}`)
    }
    throw new Error(raw || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

function fmtTs(value: string | number | null | undefined): string {
  if (!value) return '--'
  let d: Date
  if (typeof value === 'number' && Number.isFinite(value)) {
    // upstream often sends epoch seconds
    d = new Date(value * 1000)
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    d = new Date(Number(value.trim()) * 1000)
  } else {
    d = new Date(value)
  }
  if (Number.isNaN(d.getTime())) return String(value)
  const now = new Date()
  const diff = d.getTime() - now.getTime()
  const absDiff = Math.abs(diff)
  
  if (absDiff < 86400000) { // Less than 24 hours
    if (diff > 0) { // Future date
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`
    } else { // Past date
      const h = Math.floor(absDiff / 3600000)
      const m = Math.floor((absDiff % 3600000) / 60000)
      if (h === 0 && m === 0) return 'just now'
      return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`
    }
  }
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function limitPercent(limit?: Limit | null): number | null {
  if (!limit) return null
  if (typeof limit.percent === 'number' && Number.isFinite(limit.percent)) return limit.percent
  if (typeof limit.usedPercent === 'number' && Number.isFinite(limit.usedPercent)) return limit.usedPercent
  return null
}

function averagePrimaryPercent(accounts: Account[]): number {
  const vals = accounts
    .map((a) => limitPercent(a.rate_limits?.requests || a.rate_limits?.primary))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!vals.length) return 0
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
}

function normalizeAccount(account: Account, currentLabel: string | null): Account {
  return {
    ...account,
    is_current: account.label === currentLabel,
    refresh_status: account.refresh_status ?? { state: 'idle', is_stale: true },
  }
}

function pctClass(p: number): string {
  if (p > 85) return 'danger'
  if (p > 60) return 'warn'
  return 'ok'
}

function resetDate(limit?: Limit | null, usage?: UsageTracking | null): Date | null {
  const raw = limit?.resetsAt ?? limit?.resetAt ?? limit?.nextResetAt ?? limit?.reset ?? usage?.rate_limit_refresh_at
  if (!raw) return null
  const date = typeof raw === 'number' ? new Date(raw * 1000) : new Date(String(raw))
  return Number.isNaN(date.getTime()) ? null : date
}

function refreshBadge(limitA?: Limit | null, limitB?: Limit | null, usage?: UsageTracking | null): { text: string; style: React.CSSProperties } | null {
  const a = resetDate(limitA, usage)
  const b = resetDate(limitB, usage)
  const stamps = [a, b].filter(Boolean).map((d) => (d as Date).getTime())
  if (!stamps.length) return null
  const ms = Math.min(...stamps) - Date.now()
  const minMs = 60 * 1000
  const maxMs = 7 * 24 * 60 * 60 * 1000
  const clamped = Math.max(minMs, Math.min(maxMs, ms))
  const ratio = (clamped - minMs) / (maxMs - minMs)
  const hue = Math.round(ratio * 120)

  let text = 'due'
  if (ms > minMs) {
    const mins = Math.floor(ms / 60000)
    const days = Math.floor(mins / (24 * 60))
    const hrs = Math.floor((mins % (24 * 60)) / 60)
    const rem = mins % 60
    if (days > 0) text = `${days}d ${hrs}h`
    else if (hrs > 0) text = `${hrs}h ${rem}m`
    else text = `${rem}m`
  }

  return {
    text: `reset in ${text}`,
    style: {
      color: `hsl(${hue}, 82%, 55%)`,
      borderColor: `hsla(${hue}, 82%, 55%, .2)`,
      background: `hsla(${hue}, 82%, 55%, .08)`,
      textTransform: 'lowercase',
    },
  }
}

function App() {
  const [apiKey, setApiKey] = useState('')
  const [actionApiKey, setActionApiKey] = useState('')
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [mode, setMode] = useState<ViewMode>('manager')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [currentLabel, setCurrentLabel] = useState<string | null>(null)
  const [aggregate, setAggregate] = useState<Aggregate>(defaultAggregate)
  const [status, setStatus] = useState('Ready')
  const [err, setErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [history, setHistory] = useState<Array<{ t: number; value: number }>>([])
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null)
  const [historyModalOpen, setHistoryModalOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyData, setHistoryData] = useState<AccountHistoryResponse | null>(null)
  const [fullStats, setFullStats] = useState<{ totals: any, daily_rollover_trend: any[] } | null>(null)
  const streamRef = useRef<EventSource | null>(null)
  const currentLabelRef = useRef<string | null>(currentLabel)
  const hasActionApiKey = actionApiKey.trim().length > 0

  const accountCount = accounts.length
  const profilesWithToken = accountCount
  const valid5hr = accounts
    .map((a) => limitPercent(a.rate_limits?.requests || a.rate_limits?.primary))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const valid7d = accounts
    .map((a) => limitPercent(a.rate_limits?.tokens || a.rate_limits?.secondary))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const avg5hr = valid5hr.length ? Math.round(valid5hr.reduce((a, b) => a + b, 0) / valid5hr.length) : null
  const avg7d = valid7d.length ? Math.round(valid7d.reduce((a, b) => a + b, 0) / valid7d.length) : null
  const displayUtilization = aggregate.aggregate_utilization_percent > 0
    ? aggregate.aggregate_utilization_percent
    : averagePrimaryPercent(accounts)
  const recommended = accounts.reduce<Account | null>((best, a) => {
    const getScore = (acc: Account) => {
      const p1 = limitPercent(acc.rate_limits?.requests || acc.rate_limits?.primary) ?? 100
      const p2 = limitPercent(acc.rate_limits?.tokens || acc.rate_limits?.secondary) ?? 100
      const r2 = resetDate(acc.rate_limits?.tokens || acc.rate_limits?.secondary, acc.usage_tracking)
      const now = Date.now()
      const msLeft = r2 ? Math.max(0, r2.getTime() - now) : 7 * 24 * 3600 * 1000
      const usage = Math.max(p1, p2)
      if (usage >= 90) { return 1e15 + msLeft }
      return msLeft
    }
    if (!best) return a
    return getScore(a) < getScore(best) ? a : best
  }, null)

  const graphPath = useMemo(() => {
    if (!history.length) return ''
    const maxY = Math.max(100, ...history.map((p) => p.value))
    const width = 100
    const height = 100
    const points = history.map((p, i) => {
      const x = (i / Math.max(history.length - 1, 1)) * width
      const y = height - (p.value / maxY) * height
      return `${x},${y}`
    })
    const line = points.join(' L ')
    return `M ${points[0]} L ${line} L ${width},${height} L 0,${height} Z`
  }, [history])

  const graphLine = useMemo(() => {
    if (!history.length) return ''
    const maxY = Math.max(100, ...history.map((p) => p.value))
    const width = 100
    const height = 100
    const points = history.map((p, i) => {
      const x = (i / Math.max(history.length - 1, 1)) * width
      const y = height - (p.value / maxY) * height
      return `${x},${y}`
    })
    return `M ${points.join(' L ')}`
  }, [history])

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.close()
      streamRef.current = null
    }
  }

  const loadCached = async (token: string) => {
    const payload = await requestJson<AccountsCachedResponse>('/api/accounts/cached', token)
    setCurrentLabel(payload.current_label)
    currentLabelRef.current = payload.current_label
    setAccounts(payload.accounts.map((a) => normalizeAccount(a, payload.current_label)))
    setAggregate(payload.aggregate)
    
    // Load the cluster-wide time-series snapshots
    try {
      setHistoryLoading(true)
      const snapData = await requestJson<{ trend: Array<{ t: string; avg_primary_pct: number; avg_secondary_pct: number }> }>('/api/usage/snapshots', token)
      if (snapData.trend?.length) {
        const cutoff = Date.now() - (24 * 60 * 60 * 1000)
        const last24h = snapData.trend
          .map((d) => {
            const primary = Number.isFinite(d.avg_primary_pct) ? d.avg_primary_pct : 0
            const secondary = Number.isFinite(d.avg_secondary_pct) ? d.avg_secondary_pct : 0
            const value = Math.round((primary + secondary) / 2)
            return { t: new Date(d.t).getTime(), value }
          })
          .filter((d) => Number.isFinite(d.t) && d.t >= cutoff)
        if (last24h.length) {
          setHistory(last24h)
        } else {
          const fallback = payload.aggregate.aggregate_utilization_percent || averagePrimaryPercent(payload.accounts)
          setHistory([{ t: Date.now(), value: fallback }])
        }
      } else {
        const fallback = payload.aggregate.aggregate_utilization_percent || averagePrimaryPercent(payload.accounts)
        setHistory([{ t: Date.now(), value: fallback }])
      }
      
      // Also fetch legacy stats for the totals cards
      const stats = await requestJson<{ totals: any, daily_rollover_trend: any[] }>('/api/usage/stats', token)
      setFullStats(stats)
    } catch {
      const fallback = payload.aggregate.aggregate_utilization_percent || averagePrimaryPercent(payload.accounts)
      setHistory([{ t: Date.now(), value: fallback }])
    } finally {
      setHistoryLoading(false)
    }
    setStatus('Loaded cached snapshot')
  }

  const startStream = (token: string) => {
    if (!token.trim()) return
    stopStream()
    setRefreshing(true)
    setStatus('Refreshing usage...')

    const streamUrl = token === SESSION_TOKEN
      ? '/api/accounts/stream'
      : `/api/accounts/stream?api_key=${encodeURIComponent(token)}`
    const es = new EventSource(streamUrl)
    streamRef.current = es

    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as StreamSnapshot
      setCurrentLabel(data.current_label)
      currentLabelRef.current = data.current_label
      const pending = new Set(data.pending_labels || [])
      setAccounts(
        data.accounts.map((a) => {
          const n = normalizeAccount(a, data.current_label)
          if (pending.has(a.label)) {
            n.refresh_status = { ...(n.refresh_status || {}), state: 'refreshing' }
          }
          return n
        }),
      )
      setAggregate(data.aggregate)
      const util = data.aggregate.aggregate_utilization_percent || averagePrimaryPercent(data.accounts)
      setHistory((prev) => [...prev, { t: Date.now(), value: util }].slice(-50))
    })

    es.addEventListener('account_update', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { account: Account; ok: boolean }
      setAccounts((prev) =>
        prev.map((a) =>
          a.label === data.account.label
            ? {
                ...normalizeAccount(data.account, currentLabelRef.current),
                refresh_status: {
                  ...(data.account.refresh_status || {}),
                  state: data.ok ? 'ok' : 'failed',
                },
              }
            : a,
        ),
      )
    })

    es.addEventListener('aggregate_update', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as Aggregate
      setAggregate(data)
      setHistory((prev) => [...prev, { t: Date.now(), value: data.aggregate_utilization_percent || displayUtilization }].slice(-50))
    })

    es.addEventListener('error', (ev) => {
      const msg = (ev as MessageEvent).data || 'Refresh error'
      setErr(msg)
    })

    es.addEventListener('complete', () => {
      setRefreshing(false)
      setStatus('Refresh complete')
      stopStream()
    })

    es.onerror = () => {
      setRefreshing(false)
      setStatus('Refresh stream closed')
      stopStream()
    }
  }

  const loginWithPassword = async () => {
    if (!username.trim() || !password) {
      setErr('Enter username and password')
      return
    }
    setErr(null)
    setLoginLoading(true)
    try {
      await requestJson('/login', '', {
        method: 'POST',
        body: JSON.stringify({ username: username.trim(), password, next: '/' }),
      })
      setApiKey(SESSION_TOKEN)
      setStatus('Signed in')
      setPassword('')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Login failed')
    } finally {
      setLoginLoading(false)
    }
  }

  const logoutSession = async () => {
    await requestJson('/logout', '', { method: 'POST', body: '{}' })
    stopStream()
    setAccounts([])
    setAggregate(defaultAggregate)
    setHistory([])
    setApiKey('')
    setStatus('Signed out')
    setErr(null)
  }

  const saveActionApiKey = () => {
    const next = apiKeyInput.trim()
    setActionApiKey(next)
    if (next) {
      localStorage.setItem(ACTION_API_KEY_STORAGE, next)
      setStatus('API key saved')
    } else {
      localStorage.removeItem(ACTION_API_KEY_STORAGE)
      setStatus('API key cleared (read-only mode)')
    }
    setApiKeyModalOpen(false)
  }

  const requireActionApiKey = (actionLabel: string): boolean => {
    if (hasActionApiKey) return true
    setErr(`API key required for ${actionLabel}.`)
    setApiKeyModalOpen(true)
    return false
  }

  const refreshNow = async () => {
    if (!apiKey.trim()) return
    setErr(null)
    await loadCached(apiKey)
    startStream(hasActionApiKey ? actionApiKey : apiKey)
  }

  const importCurrent = async () => {
    if (!apiKey.trim()) return
    if (!requireActionApiKey('import')) return
    setErr(null)
    setStatus('Importing current auth...')
    await requestJson('/auth/import-current', actionApiKey, { method: 'POST', body: '{}' })
    await refreshNow()
    setStatus('Imported current auth')
  }

  const addAccount = async () => {
    if (!apiKey.trim()) return
    setErr(null)
    try {
      const start = await requestJson<{ auth_url?: string; session_id?: string; relay_token?: string; instructions?: string }>(
        '/auth/login/start-relay',
        apiKey,
        { method: 'POST', body: '{}' },
      )
      if (start.auth_url) window.open(start.auth_url, '_blank', 'noopener,noreferrer')
      const callbackUrl = window.prompt('Paste full callback URL from the auth tab:')?.trim()
      if (!callbackUrl) return
      const label = window.prompt('Optional profile label (leave empty for auto):')?.trim() || undefined
      await requestJson(
        '/auth/relay-callback',
        apiKey,
        {
          method: 'POST',
          body: JSON.stringify({
            full_url: callbackUrl,
            relay_token: start.relay_token,
            session_id: start.session_id,
            label,
          }),
        },
      )
      setStatus('Callback relayed. Refreshing...')
      await refreshNow()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Add account failed')
    }
  }

  const switchAccount = async (label: string) => {
    if (!requireActionApiKey('switch')) return
    await requestJson('/auth/switch', actionApiKey, { method: 'POST', body: JSON.stringify({ label }) })
    setStatus(`Switched to ${label}`)
    setOpenMenuFor(null)
    await refreshNow()
  }

  const renameAccount = async (oldLabel: string, currentName: string) => {
    if (!requireActionApiKey('rename')) return
    const next = window.prompt('New profile label:', currentName)?.trim()
    if (!next || next === oldLabel) return
    await requestJson('/auth/rename', actionApiKey, {
      method: 'POST',
      body: JSON.stringify({ old_label: oldLabel, new_label: next }),
    })
    setStatus(`Renamed ${oldLabel} -> ${next}`)
    setOpenMenuFor(null)
    await refreshNow()
  }

  const deleteAccount = async (label: string) => {
    if (!requireActionApiKey('delete')) return
    if (!window.confirm(`Delete profile '${label}'?`)) return
    await requestJson('/auth/delete', actionApiKey, { method: 'POST', body: JSON.stringify({ label }) })
    setStatus(`Deleted ${label}`)
    setOpenMenuFor(null)
    await refreshNow()
  }

  const exportAccount = async (label: string) => {
    if (!requireActionApiKey('export')) return
    const res = await fetch(`/auth/export?label=${encodeURIComponent(label)}`, {
      credentials: 'include',
      headers: authHeaders(actionApiKey),
    })
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json()
    const blob = new Blob([JSON.stringify(data.auth_json, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${label}.auth.json`
    a.click()
    URL.revokeObjectURL(url)
    setOpenMenuFor(null)
  }

  const openAccountHistory = async (label: string) => {
    if (!apiKey.trim()) return
    setHistoryModalOpen(true)
    setHistoryLoading(true)
    setHistoryError(null)
    setHistoryData(null)
    try {
      // Fetch both the legacy usage-history and the new snapshots endpoint
      const [histPayload, snapPayload] = await Promise.all([
        requestJson<AccountHistoryResponse>(
          `/api/accounts/${encodeURIComponent(label)}/usage-history`,
          apiKey,
        ),
        requestJson<{ label: string; trend: Array<{ t: string; avg_primary_pct: number; avg_secondary_pct: number }>; rollovers: any[] }>(
          `/api/accounts/${encodeURIComponent(label)}/snapshots`,
          apiKey,
        ).catch(() => null),
      ])
      // Merge snapshot trend into history data for rendering
      setHistoryData({
        ...histPayload,
        _snapshot_trend: snapPayload?.trend || [],
        rollovers: snapPayload?.rollovers || histPayload.rollovers || [],
      } as any)
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : 'Unable to load account history')
    } finally {
      setHistoryLoading(false)
    }
  }

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.menu-root')) {
        setOpenMenuFor(null)
      }
    }
    document.addEventListener('click', handleOutsideClick)
    return () => document.removeEventListener('click', handleOutsideClick)
  }, [])

  useEffect(() => {
    const stored = localStorage.getItem(ACTION_API_KEY_STORAGE) || ''
    setActionApiKey(stored)
    setApiKeyInput(stored)
  }, [])

  useEffect(() => {
    if (!apiKey.trim()) {
      void requestJson('/api/public-stats', '')
        .then(() => setApiKey(SESSION_TOKEN))
        .catch(() => {})
      return
    }
    void loadCached(apiKey)
      .then(() => startStream(hasActionApiKey ? actionApiKey : apiKey))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Load failed'))
    return () => stopStream()
  }, [apiKey, actionApiKey, hasActionApiKey])

  if (!apiKey.trim()) {
    return (
      <div className="page">
        <div className="login-card panel">
          <div className="brand"><span className="dot" />Auth Manager</div>
          <h2>Sign In</h2>
          <p>Use the username/password from environment configuration.</p>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            style={{ marginBottom: 8 }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
          <div className="top-actions">
            <button className="btn primary" onClick={() => void loginWithPassword()} disabled={loginLoading}>
              {loginLoading ? 'Signing in...' : 'Continue'}
            </button>
          </div>
          {err ? <div className="error">{err}</div> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="top">
        <div className="brand"><span className="dot" />Auth Manager</div>
        <div className="top-actions">
          <button
            className={`btn api-key-btn ${hasActionApiKey ? 'ready' : 'missing'}`}
            onClick={() => setApiKeyModalOpen(true)}
          >
            {hasActionApiKey ? 'API Key: Set' : 'API Key: Missing'}
          </button>
          {mode === 'manager' ? <button className="btn primary" onClick={() => void addAccount()}>+ Add Account</button> : null}
          {mode === 'manager' ? <button className="btn" onClick={() => void importCurrent()} disabled={!hasActionApiKey}>Import Current</button> : null}
          <button className="btn" onClick={() => setMode((m) => (m === 'manager' ? 'stats' : 'manager'))}>
            {mode === 'manager' ? 'Overall Stats' : 'Back to Manager'}
          </button>
          <button className="btn" onClick={() => void refreshNow()} disabled={refreshing}>
            {refreshing ? (
              <span className="btn-with-spinner">
                <span className="spinner" aria-hidden="true" />
                Refresh
              </span>
            ) : (
              'Refresh'
            )}
          </button>
          <button className="btn" onClick={() => void logoutSession()}>Logout</button>
        </div>
      </header>

      {err ? <div className="error panel">{err}</div> : null}

      {mode === 'manager' ? (
        <>
          <section className="dashboard-grid">
            <div className="panel overflow-hidden">
              <h4 className="panel-title">System Overview</h4>
              <div className="summary-grid">
                <div>
                  <label>Managed Accounts</label>
                  <strong>{accountCount}</strong>
                </div>
                <div>
                  <label>Next Refresh</label>
                  <strong style={{ color: '#10b981' }}>{refreshBadge(recommended?.rate_limits?.requests || recommended?.rate_limits?.primary, recommended?.rate_limits?.tokens || recommended?.rate_limits?.secondary, recommended?.usage_tracking)?.text.replace('reset in ', '') || '--'}</strong>
                </div>
              </div>
              
              <div className="sparkline-container" style={{ marginTop: 16 }}>
                 <div className="graph-label">Usage Trend (24h)</div>
                 <div className="sparkline">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                       {history.length > 0 && <path d={graphPath} fill="rgba(16, 185, 129, 0.05)" />}
                       {history.length > 0 && <path d={graphLine} fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
                    </svg>
                 </div>
              </div>
            </div>
            <div className="panel">
              <h4 className="panel-title">Aggregated Usage</h4>
              <div className="limit-row"><span>5hr</span><div className="bar"><span className={`fill ${pctClass(avg5hr || 0)}`} style={{ width: `${avg5hr || 0}%` }} /></div><span>{avg5hr === null ? '--' : `${avg5hr}%`}</span></div>
              <div className="muted">{avg5hr === null ? 'No live 5hr data available.' : `${Math.max(0, 100 - avg5hr)}% remaining across cluster`}</div>
              <div className="limit-row" style={{ marginTop: 8 }}><span>7d</span><div className="bar"><span className={`fill ${pctClass(avg7d || 0)}`} style={{ width: `${avg7d || 0}%` }} /></div><span>{avg7d === null ? '--' : `${avg7d}%`}</span></div>
              <div className="muted">{avg7d === null ? 'No live 7d data available.' : `${Math.max(0, 100 - avg7d)}% remaining across cluster`}</div>
              <label style={{ marginTop: 10 }}>Recommended Profile</label>
              <div style={{ marginTop: 8 }}>
                {recommended ? (
                  <button className="btn btn-sm rec-btn" onClick={() => void switchAccount(recommended.label)}>
                    Switch to {recommended.display_label || recommended.label}
                  </button>
                ) : (
                  <span className="muted">--</span>
                )}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="saved-head">
              <h3>Saved Profiles</h3>
              <span className="pill">{accountCount} account{accountCount === 1 ? '' : 's'}</span>
            </div>
            <div className="table-head">
              <span>Profile</span>
              <span>Rate Limits</span>
              <span>Rate Limit Reset</span>
              <span>Actions</span>
            </div>
            {accounts.length === 0 ? <div className="empty">No accounts found.</div> : null}
            {accounts.map((a) => {
              const primary = a.rate_limits?.requests || a.rate_limits?.primary
              const secondary = a.rate_limits?.tokens || a.rate_limits?.secondary
              const p1Raw = limitPercent(primary)
              const p2Raw = limitPercent(secondary)
              const p1 = p1Raw === null ? null : Math.max(0, Math.min(100, p1Raw))
              const p2 = p2Raw === null ? null : Math.max(0, Math.min(100, p2Raw))
              const rateError = typeof a.rate_limits?.error === 'string' ? a.rate_limits.error : ''
              const scopeError = rateError.includes('Missing scopes') ? 'Live rate-limit scopes are missing for this account.' : rateError
              const badge = refreshBadge(secondary, null, undefined)
              return (
                <div className="row" key={`${a.account_key}:${a.label}`}>
                  <div>
                    <div className="profile-title">
                      <button className="profile-link-btn" onClick={() => void openAccountHistory(a.label)}>
                        {a.display_label || a.label}
                      </button>
                      {badge ? <span className="pill" style={badge.style}>{badge.text}</span> : null}
                    </div>
                    <div className="muted">{a.email || 'email unavailable'}</div>
                    <div className="muted mono">Profile label: {a.label}</div>
                  </div>
                  <div>
                    {p1 !== null || p2 !== null ? (
                      <>
                        <div className="limit-row"><span>5hr</span><div className="bar"><span className={`fill ${pctClass(p1 || 0)}`} style={{ width: `${p1 || 0}%` }} /></div><span>{p1 === null ? '--' : `${p1}%`}</span></div>
                        <div className="limit-row"><span>7d</span><div className="bar"><span className={`fill ${pctClass(p2 || 0)}`} style={{ width: `${p2 || 0}%` }} /></div><span>{p2 === null ? '--' : `${p2}%`}</span></div>
                      </>
                    ) : (
                      <div className="muted">{scopeError || 'No live rate-limit data available.'}</div>
                    )}
                  </div>
                  <div>
                    <div className="muted">{p1 !== null ? fmtTs(primary?.resetsAt || primary?.resetAt) : '--'}</div>
                    <div className="muted">{p2 !== null ? fmtTs(secondary?.resetsAt || secondary?.resetAt) : '--'}</div>
                  </div>
                  <div className="actions-col">
                    <div className="menu-root" onMouseLeave={() => setOpenMenuFor(null)}>
                      <button className="btn btn-sm" onClick={() => setOpenMenuFor(openMenuFor === a.label ? null : a.label)}>
                        Actions
                      </button>
                      {openMenuFor === a.label ? (
                        <div className="menu-panel">
                          <button className="menu-item" onClick={() => void switchAccount(a.label)} disabled={!hasActionApiKey}>{a.is_current ? 'Switch (Current)' : 'Switch'}</button>
                          <button className="menu-item" onClick={() => void renameAccount(a.label, a.display_label || a.label)} disabled={!hasActionApiKey}>Change profile label</button>
                          <button className="menu-item" onClick={() => void exportAccount(a.label)} disabled={!hasActionApiKey}>Export</button>
                          <button className="menu-item danger" onClick={() => void deleteAccount(a.label)} disabled={!hasActionApiKey}>Delete</button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        </>
      ) : (
        <section className="aggregate panel">
          <div className="aggregate-header">
            <h2>Aggregated Usage Analytics</h2>
            <p className="muted">Cluster-wide utilization and historical trend across managed accounts.</p>
          </div>
          <div className="cards">
            <div><label>Total Used</label><strong>{fullStats?.totals ? fullStats.totals.active_window_used : (aggregate.total_current_window_limit > 0 ? aggregate.total_current_window_used : '--')}</strong></div>
            <div><label>Total Limit</label><strong>{fullStats?.totals ? fullStats.totals.active_window_limit : (aggregate.total_current_window_limit > 0 ? aggregate.total_current_window_limit : '--')}</strong></div>
            <div><label>Combined Remaining</label><strong>{fullStats?.totals ? (fullStats.totals.active_window_limit - fullStats.totals.active_window_used) : (aggregate.total_current_window_limit > 0 ? aggregate.total_remaining : '--')}</strong></div>
            <div className="accent-card"><label>Global Utilization</label><strong style={{ color: '#10b981' }}>{displayUtilization}%</strong></div>
            <div><label>Lifetime Tokens</label><strong>{fullStats?.totals?.lifetime_used ?? aggregate.lifetime_total_used}</strong></div>
            <div className={ (fullStats?.totals?.total_wasted || aggregate.total_wasted) > 1000 ? 'warn-card' : '' }><label>Total Wasted</label><strong>{fullStats?.totals?.total_wasted ?? aggregate.total_wasted}</strong></div>
            <div><label>Managed Accounts</label><strong>{accountCount}</strong></div>
            <div><label>Stale / Failed</label><strong>{aggregate.stale_accounts} / {aggregate.failed_accounts}</strong></div>
            <div><label>Last Full Refresh</label><strong>{fmtTs(aggregate.last_refresh_time)}</strong></div>
          </div>
          {aggregate.total_current_window_limit === 0 && !fullStats?.totals?.active_window_limit ? (
            <div className="muted" style={{ marginTop: 12, padding: '0 4px' }}>
              ℹ️ Absolute token counts are derived from historical window captures when available. Current utilization is mapped from realtime percentages.
            </div>
          ) : null}
          <div className="graph-container">
            <div className="graph-label">Utilization Trend (24h)</div>
            <div className="graph">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="usageGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {history.length > 0 && <path d={graphPath} fill="url(#usageGradient)" />}
                {history.length > 0 && <path d={graphLine} fill="none" stroke="#10b981" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />}
              </svg>
              <div className="graph-meta">
                <span>Cluster Efficiency</span>
                <span>Moving Average</span>
              </div>
            </div>
          </div>
          
          {fullStats?.daily_rollover_trend && fullStats.daily_rollover_trend.length > 1 && (
             <div className="graph-container" style={{ marginTop: 32 }}>
               <div className="graph-label">Wasted Tokens History</div>
               <div className="graph grayscale">
                 <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                    <path d={(() => {
                        const trend = fullStats.daily_rollover_trend;
                        const maxWasted = Math.max(1, ...trend.map(t => t.sum_wasted));
                        const points = trend.map((t, i) => {
                          const x = (i / (trend.length - 1)) * 100;
                          const y = 100 - (t.sum_wasted / maxWasted) * 100;
                          return `${x},${y}`;
                        });
                        return `M ${points[0]} L ${points.join(' L ')} L 100,100 L 0,100 Z`;
                    })()} fill="rgba(245, 158, 11, 0.1)" />
                    <path d={(() => {
                        const trend = fullStats.daily_rollover_trend;
                        const maxWasted = Math.max(1, ...trend.map(t => t.sum_wasted));
                        const points = trend.map((t, i) => {
                          const x = (i / (trend.length - 1)) * 100;
                          const y = 100 - (t.sum_wasted / maxWasted) * 100;
                          return `${x},${y}`;
                        });
                        return `M ${points.join(' L ')}`;
                    })()} fill="none" stroke="#f59e0b" strokeWidth="1" strokeDasharray="3 2" />
                 </svg>
                 <div className="graph-meta">
                    <span>Quota Exhaustion Leak</span>
                    <span>Historical Loss</span>
                 </div>
               </div>
             </div>
          )}
        </section>
      )}

      {historyModalOpen ? (
        <div className="modal-overlay" onClick={() => setHistoryModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Account History</h3>
              <button className="btn btn-sm" onClick={() => setHistoryModalOpen(false)}>Close</button>
            </div>
            {historyLoading ? <div className="muted">Loading...</div> : null}
            {historyError ? <div className="error">{historyError}</div> : null}
            {historyData ? (
              <div>
                <div className="muted"><strong>{historyData.display_label || historyData.label}</strong> · {historyData.email || 'email unavailable'}</div>
                
                {/* Chart: Utilization % over time */}
                {(historyData as any)?._snapshot_trend?.length > 1 && (
                  <div className="graph-container" style={{ marginTop: 16 }}>
                    <div className="graph-label">Usage % Over Time (7d)</div>
                    <div className="graph">
                      <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                        <defs>
                          <linearGradient id="acctGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.25" />
                            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        {(() => {
                          const trend = (historyData as any)._snapshot_trend as Array<{ t: string; avg_primary_pct: number; avg_secondary_pct: number }>
                          const maxVal = Math.max(100, ...trend.map(d => Math.max(d.avg_primary_pct, d.avg_secondary_pct)))
                          const points = trend.map((d, i) => {
                            const x = (i / (trend.length - 1)) * 100
                            const y = 100 - (Math.max(d.avg_primary_pct, d.avg_secondary_pct) / maxVal) * 100
                            return `${x},${y}`
                          })
                          const linePath = `M ${points.join(' L ')}`
                          const fillPath = `${linePath} L 100,100 L 0,100 Z`
                          return (
                            <>
                              <path d={fillPath} fill="url(#acctGradient)" />
                              <path d={linePath} fill="none" stroke="#6366f1" strokeWidth="1.5" />
                            </>
                          )
                        })()}
                      </svg>
                      <div className="graph-meta">
                        <span>5hr / 7d Usage %</span>
                        <span>Hourly Average</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Summary cards */}
                <div className="cards" style={{ marginTop: 12 }}>
                  <div><label>Completed Windows</label><strong>{historyData.summary?.window_count ?? 0}</strong></div>
                  <div><label>Avg Utilization</label><strong>{historyData.summary?.avg_completed_utilization_percent ?? '--'}%</strong></div>
                  <div>
                    <label>% Wasted Last Reset</label>
                    <strong className="text-warn">
                      {historyData.rollovers?.length
                        ? (() => {
                            const last = historyData.rollovers[historyData.rollovers.length - 1] as any
                            const pct = last?.secondary_percent_at_reset
                            return pct != null ? `${Math.round(100 - pct)}%` : '--'
                          })()
                        : '--'}
                    </strong>
                  </div>
                </div>

                {/* Rollover table with percentage data */}
                <div className="history-table">
                  <div className="history-head">
                    <span>End Date</span>
                    <span>5hr %</span>
                    <span>7d %</span>
                    <span>Wasted %</span>
                  </div>
                  {historyData.rollovers?.length ? historyData.rollovers.slice(-10).reverse().map((r: any, idx: number) => (
                    <div key={idx} className="history-row">
                      <span>{fmtTs(r.window_ended_at || '')}</span>
                      <span className="mono">{r.primary_percent_at_reset != null ? `${r.primary_percent_at_reset}%` : '--'}</span>
                      <span className="mono">{r.secondary_percent_at_reset != null ? `${r.secondary_percent_at_reset}%` : '--'}</span>
                      <span className={r.secondary_percent_at_reset != null && (100 - r.secondary_percent_at_reset) > 30 ? 'text-warn' : ''}>
                        {r.secondary_percent_at_reset != null ? `${Math.round(100 - r.secondary_percent_at_reset)}%` : '--'}
                      </span>
                    </div>
                  )) : <div className="muted" style={{ padding: 12 }}>No rollover history yet.</div>}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {apiKeyModalOpen ? (
        <div className="modal-overlay" onClick={() => setApiKeyModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>API Key</h3>
              <button className="btn btn-sm" onClick={() => setApiKeyModalOpen(false)}>Close</button>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>
              Required for refresh, import, rename, delete, and export. Read-only viewing and Add Account work without it.
            </p>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="Paste API key"
              className="api-key-input"
            />
            <div className="top-actions" style={{ marginTop: 12 }}>
              <button className="btn primary" onClick={saveActionApiKey}>Save</button>
              <button
                className="btn"
                onClick={() => {
                  setApiKeyInput('')
                  setActionApiKey('')
                  localStorage.removeItem(ACTION_API_KEY_STORAGE)
                  setStatus('API key cleared (read-only mode)')
                  setApiKeyModalOpen(false)
                }}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
