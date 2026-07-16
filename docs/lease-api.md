# Lease API Integration Guide

This guide documents the lease broker API exposed by the Auth Manager backend for other applications that need to borrow an approved credential, materialize auth locally, and keep the lease healthy over time.

## Base Requirements

- Base URL: your Auth Manager deployment, for example `https://auth-manager.example.com`
- Auth header: `Authorization: Bearer <INTERNAL_API_TOKEN>`
- Alternate auth header: `X-API-Key: <INTERNAL_API_TOKEN>`
- Content type for writes: `application/json`

If `INTERNAL_API_TOKEN` is not configured server-side, lease endpoints return `503`. If a token is missing, they return `401`. If a token is present but invalid, they return `403`.

## Ownership Model

Every lease belongs to a `(machine_id, agent_id)` pair.

- `machine_id` should identify the host or runtime environment
- `agent_id` should identify the consuming application or worker on that machine
- renew, release, materialize, telemetry, and reconcile-auth all require the same owner pair that acquired the lease
- when ownership does not match, the API denies the action

One important behavior: `POST /api/leases/acquire` reuses an existing active lease for the same `machine_id` before assigning a new credential. If your application expects one lease per machine, this is helpful. If it expects one lease per process, account for this reuse behavior.

## Recommended Client Flow

1. Acquire a lease with `POST /api/leases/acquire`.
2. Materialize the credential with `POST /api/leases/{lease_id}/materialize`.
3. Write `credential_material.auth_json` into the local auth location your app uses.
4. Periodically call `GET /api/leases/{lease_id}`.
5. Renew before expiry when the lease is still healthy.
6. Post truthful usage/health telemetry to `POST /api/leases/{lease_id}/telemetry`.
7. Rotate when `replacement_required=true`, or when your policy allows rotation on `rotation_recommended=true`.
8. Release the lease when shutting down or when you no longer need the credential.

## Common Response Pattern

Most mutating lease endpoints return this shape:

```json
{
  "status": "ok",
  "reason": null,
  "lease": {
    "id": "lease_123",
    "credential_id": "acct_123",
    "machine_id": "worker-01",
    "agent_id": "my-app",
    "state": "active",
    "issued_at": "2026-03-23T00:00:00+00:00",
    "expires_at": "2026-03-23T01:00:00+00:00"
  }
}
```

On broker-level denials, the server usually returns `409` with:

```json
{
  "status": "denied",
  "reason": "no_eligible_credentials_available",
  "lease": null
}
```

Treat `status=denied` as an application-level outcome, not a transport failure.

## Endpoints

### Acquire

`POST /api/leases/acquire`

Request:

```json
{
  "machine_id": "worker-01",
  "agent_id": "my-app",
  "requested_ttl_seconds": 1800,
  "reason": "startup",
  "exclude_credential_ids": ["acct_older"]
}
```

Required fields:

- `machine_id`
- `agent_id`

Optional fields:

- `requested_ttl_seconds`
- `reason`
- `exclude_credential_ids`

Success:

- `200 OK`
- returns `status: "ok"` and a `lease`

Denial cases:

- `409` with `reason: "no_eligible_credentials_available"`

Notes:

- the server may return `reason: "existing_machine_lease_reused"` with `status: "ok"` when the same `machine_id` already owns an active lease
- the selected credential is policy filtered server-side

### Get Lease Status

`GET /api/leases/{lease_id}`

Success:

```json
{
  "lease_id": "lease_123",
  "credential_id": "acct_123",
  "state": "active",
  "issued_at": "2026-03-23T00:00:00+00:00",
  "expires_at": "2026-03-23T01:00:00+00:00",
  "renewed_at": null,
  "machine_id": "worker-01",
  "agent_id": "my-app",
  "latest_telemetry_at": "2026-03-23T00:10:00+00:00",
  "latest_utilization_pct": 42.0,
  "latest_quota_remaining": 58000,
  "last_success_at": "2026-03-23T00:09:00+00:00",
  "last_error_at": null,
  "rotation_recommended": false,
  "replacement_required": false,
  "reason": null,
  "credential_state": "leased",
  "primary_utilization_pct": 42.0,
  "primary_reset_at": "2026-03-30T00:00:00+00:00",
  "secondary_utilization_pct": null,
  "secondary_reset_at": null,
  "credential_auth_updated_at": "2026-03-23T00:05:00+00:00",
  "auth_refresh_required": false,
  "effective_rotation_policy": "replacement_required_only",
  "last_seen_at": "2026-03-23T00:10:00+00:00",
  "seconds_since_seen": 0,
  "is_stale": false
}
```

Possible HTTP errors:

- `404` if the lease does not exist

Interpretation rules:

- `replacement_required=true`: rotate or reacquire immediately
- `rotation_recommended=true`: rotate if your client policy allows it
- `auth_refresh_required=true`: your local materialized auth is older than the manager’s stored auth
- `state` may become `rotation_required`, `revoked`, `released`, or `expired`

### Renew

`POST /api/leases/{lease_id}/renew`

Request:

```json
{
  "machine_id": "worker-01",
  "agent_id": "my-app"
}
```

Success:

- `200 OK`
- returns `status: "ok"` and the updated lease

Common denials:

- `409` with `reason: "lease_not_found_or_not_owned"`
- `409` with `reason` starting `lease_not_renewable:`
- `409` with `reason: "credential_not_usable"`

### Release

`POST /api/leases/{lease_id}/release`

Request:

```json
{
  "machine_id": "worker-01",
  "agent_id": "my-app",
  "reason": "shutdown"
}
```

Success:

- `200 OK`
- lease state becomes `released`
- the credential usually returns to the available pool

Common denials:

- `409` with `reason: "lease_not_found_or_not_owned"`
- `409` with `reason` starting `lease_not_releasable:`

### Telemetry

`POST /api/leases/{lease_id}/telemetry`

Use this to report truthful, observed usage and health.

Request:

```json
{
  "machine_id": "worker-01",
  "agent_id": "my-app",
  "captured_at": "2026-03-23T00:10:00+00:00",
  "requests_count": 1,
  "tokens_in": 1234,
  "tokens_out": 456,
  "utilization_pct": 42.0,
  "quota_remaining": 58000,
  "rate_limit_remaining": 100,
  "status": "ok",
  "last_success_at": "2026-03-23T00:09:00+00:00",
  "last_error_at": null,
  "error_rate_1h": 0.0,
  "metadata": {
    "source": "my-app"
  }
}
```

Required fields:

- `machine_id`
- `agent_id`
- `captured_at`

Optional fields:

- `requests_count`
- `tokens_in`
- `tokens_out`
- `utilization_pct`
- `quota_remaining`
- `rate_limit_remaining`
- `status`
- `last_success_at`
- `last_error_at`
- `error_rate_1h`
- `metadata`

Success:

- `200 OK`
- returns the updated lease and credential summary

Important behavior:

- telemetry at or above the rotation threshold can move the lease to `state: "rotation_required"`
- telemetry at or above the exhausted threshold can mark the credential `exhausted` and revoke the active lease
- the backend may override posted utilization/quota values with fresher broker credential state when that state already exists

Common denials:

- `409` with `reason: "lease_not_found_or_not_owned"`

### Materialize Credential

`POST /api/leases/{lease_id}/materialize`

Request:

```json
{
  "machine_id": "worker-01",
  "agent_id": "my-app"
}
```

Success:

```json
{
  "status": "ok",
  "reason": null,
  "lease": {
    "id": "lease_123",
    "credential_id": "acct_123",
    "machine_id": "worker-01",
    "agent_id": "my-app",
    "state": "active",
    "metadata": {
      "delivery_count": 1,
      "first_materialized_at": "2026-03-23T00:00:05+00:00",
      "last_materialized_at": "2026-03-23T00:00:05+00:00",
      "credential_auth_updated_at": "2026-03-23T00:00:00+00:00"
    }
  },
  "credential_material": {
    "label": "alice",
    "account_key": "acct_123",
    "email": "alice@example.com",
    "name": "Alice",
    "provider_account_id": "provider-123",
    "auth_json": {
      "auth_mode": "chatgpt",
      "OPENAI_API_KEY": null,
      "tokens": {
        "id_token": "id-token",
        "access_token": "access-token",
        "refresh_token": "",
        "account_id": "acct_123"
      },
      "last_refresh": "2026-03-23T00:00:00+00:00"
    },
    "openclaw": {
      "auth_mode": "chatgpt"
    }
  }
}
```

Notes:

- the payload most applications need is `credential_material.auth_json`
- the response also includes profile metadata that can be useful for display or account sanity checks
- leased payloads intentionally contain an empty `refresh_token`; only the manager refresh worker owns token rotation
- explicit administrative exports such as `GET /auth/export` retain the complete stored refresh token

Common errors:

- `404` with `reason: "credential_material_not_found"` when the lease exists but the backing auth material is missing
- `409` with `reason: "lease_not_found_or_not_owned"`
- `409` with `reason` starting `lease_not_materializable:`
- `409` with `reason: "credential_not_usable"`

### Reconcile Auth

`POST /api/leases/{lease_id}/reconcile-auth`

Use this to compare the local leased auth generation and identity with the manager. Leased clients do not refresh OAuth tokens locally.

Request:

```json
{
  "machine_id": "worker-01",
  "agent_id": "my-app",
  "auth_json": {
    "auth_mode": "chatgpt",
    "OPENAI_API_KEY": null,
    "tokens": {
      "id_token": "id-token",
      "access_token": "access-token",
      "refresh_token": "",
      "account_id": "acct_123"
    },
    "last_refresh": "2026-03-23T00:15:00+00:00"
  }
}
```

Success responses always use `200 OK` with `status: "ok"` and a `decision`.

Possible decisions:

- `in_sync`: no action needed
- `client_updated_manager`: compatibility behavior for a previously issued full auth payload; new leased payloads cannot rotate locally
- `manager_updated_client`: the manager has newer auth; replace your local auth with `auth_json` from the response
- `identity_mismatch`: the incoming auth does not appear to belong to the leased credential; do not overwrite your lease context blindly
- `manager_missing_auth`: the manager does not currently have auth material for the leased credential

Possible HTTP errors:

- `400` if `machine_id`, `agent_id`, or `auth_json` is missing
- `404` if the lease does not exist
- `409` if the lease is not owned by the caller

### Rotate

`POST /api/leases/rotate`

Request:

```json
{
  "lease_id": "lease_123",
  "machine_id": "worker-01",
  "agent_id": "my-app",
  "reason": "expiry_approaching"
}
```

Allowed `reason` values:

- `approaching_utilization_threshold`
- `low_quota_remaining`
- `unhealthy_credential`
- `expiry_approaching`
- `admin_requested_rotation`

Success:

- `200 OK`
- returns a brand-new lease on a replacement credential
- the old lease is marked `released`
- the old lease records `replacement_lease_id`

Common denials:

- `409` with `reason: "client_rotation_disabled"`
- `409` with `reason: "lease_not_found_or_not_owned"`
- `409` with `reason` starting `lease_not_rotatable:`
- `409` with `reason: "no_eligible_credentials_available"`

Validation errors:

- `400` if `lease_id`, `machine_id`, `agent_id`, or `reason` is missing
- `400` if `reason` is not one of the allowed values

## Minimal cURL Examples

Acquire:

```bash
curl -X POST "$AUTH_MANAGER_BASE_URL/api/leases/acquire" \
  -H "Authorization: Bearer $AUTH_MANAGER_INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "machine_id": "worker-01",
    "agent_id": "my-app",
    "reason": "startup"
  }'
```

Materialize:

```bash
curl -X POST "$AUTH_MANAGER_BASE_URL/api/leases/$LEASE_ID/materialize" \
  -H "Authorization: Bearer $AUTH_MANAGER_INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "machine_id": "worker-01",
    "agent_id": "my-app"
  }'
```

Telemetry:

```bash
curl -X POST "$AUTH_MANAGER_BASE_URL/api/leases/$LEASE_ID/telemetry" \
  -H "Authorization: Bearer $AUTH_MANAGER_INTERNAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "machine_id": "worker-01",
    "agent_id": "my-app",
    "captured_at": "2026-03-23T00:10:00+00:00",
    "status": "ok",
    "requests_count": 1,
    "tokens_in": 1234,
    "tokens_out": 456
  }'
```

## Integration Notes

- ISO 8601 timestamps are expected for all date/time fields.
- Use stable `machine_id` and `agent_id` values across the full lease lifecycle.
- Do not invent telemetry. The backend logic assumes these numbers reflect real observed usage.
- Handle `409` denial bodies explicitly; they are part of the normal lease lifecycle.
- If you materialize auth and later see `auth_refresh_required=true`, call `reconcile-auth` or materialize again before assuming your local copy is current.
