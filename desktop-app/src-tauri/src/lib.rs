use dirs::{config_dir, home_dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSettings {
    base_url: String,
    internal_api_token: String,
    machine_id: String,
    agent_id: String,
    auth_file_path: String,
    refresh_interval_seconds: i64,
    telemetry_interval_seconds: i64,
    auto_renew: bool,
    auto_rotate: bool,
    open_dashboard_path: String,
    allow_insecure_localhost: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLeaseState {
    machine_id: String,
    agent_id: String,
    lease_id: Option<String>,
    credential_id: Option<String>,
    issued_at: Option<String>,
    expires_at: Option<String>,
    lease_state: Option<String>,
    latest_telemetry_at: Option<String>,
    latest_utilization_pct: Option<f64>,
    latest_quota_remaining: Option<f64>,
    last_auth_write_at: Option<String>,
    last_backend_refresh_at: Option<String>,
    replacement_required: bool,
    rotation_recommended: bool,
    last_error_at: Option<String>,
    auth_file_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDesktopState {
    settings: RuntimeSettings,
    lease: RuntimeLeaseState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthFileWriteResult {
    path: String,
    written_at: String,
}

fn app_dir() -> Result<PathBuf, String> {
    let Some(base) = config_dir() else {
        return Err("Unable to determine config directory".into());
    };
    Ok(base.join("codex-auth-manager-desktop"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("state.json"))
}

fn log_path() -> Result<PathBuf, String> {
    Ok(app_dir()?.join("desktop.log"))
}

fn expand_home_path(raw_path: &str) -> Result<PathBuf, String> {
    if !raw_path.starts_with('~') {
        return Ok(PathBuf::from(raw_path));
    }
    let Some(home) = home_dir() else {
        return Err("Unable to determine home directory".into());
    };
    Ok(home.join(raw_path.trim_start_matches('~').trim_start_matches('/')))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_auth_payload(payload: &Value) -> Result<(), String> {
    let Some(record) = payload.as_object() else {
        return Err("Auth payload must be an object".into());
    };
    if !matches!(record.get("auth_mode"), Some(Value::String(_))) {
        return Err("Auth payload is missing auth_mode".into());
    }
    if !matches!(record.get("OPENAI_API_KEY"), Some(Value::Null)) {
        return Err("Auth payload OPENAI_API_KEY must be null".into());
    }
    let Some(tokens) = record.get("tokens").and_then(|value| value.as_object()) else {
        return Err("Auth payload is missing tokens".into());
    };
    for key in ["id_token", "access_token", "refresh_token", "account_id"] {
        if !matches!(tokens.get(key), Some(Value::String(_))) {
            return Err(format!("Auth payload is missing {key}"));
        }
    }
    Ok(())
}

#[tauri::command]
fn load_persisted_state() -> Result<Option<PersistedDesktopState>, String> {
    let path = state_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let state = serde_json::from_str::<PersistedDesktopState>(&content).map_err(|error| error.to_string())?;
    Ok(Some(state))
}

#[tauri::command]
fn save_persisted_state(state: PersistedDesktopState) -> Result<(), String> {
    let path = state_path()?;
    ensure_parent(&path)?;
    let temp = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(&temp, format!("{json}\n")).map_err(|error| error.to_string())?;
    fs::rename(temp, path).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn auth_file_exists(auth_file_path: String) -> Result<bool, String> {
    let path = expand_home_path(&auth_file_path)?;
    Ok(path.exists())
}

#[tauri::command]
fn read_auth_file(auth_file_path: String) -> Result<Option<Value>, String> {
    let path = expand_home_path(&auth_file_path)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let parsed = serde_json::from_str::<Value>(&content).map_err(|error| error.to_string())?;
    Ok(Some(parsed))
}

#[tauri::command]
fn write_auth_file(auth_file_path: String, payload: Value) -> Result<AuthFileWriteResult, String> {
    validate_auth_payload(&payload)?;
    let path = expand_home_path(&auth_file_path)?;
    ensure_parent(&path)?;
    let written_at = chrono_like_now();
    let mut object = payload.as_object().cloned().ok_or_else(|| "Auth payload must be an object".to_string())?;
    if object.get("last_refresh").is_none() {
        object.insert("last_refresh".into(), Value::String(written_at.clone()));
    }
    let temp = path.with_extension("tmp");
    let mut file = File::create(&temp).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(&Value::Object(object)).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(temp, &path).map_err(|error| error.to_string())?;
    Ok(AuthFileWriteResult {
        path: path.to_string_lossy().to_string(),
        written_at,
    })
}

#[tauri::command]
fn append_log_line(message: String) -> Result<(), String> {
    let path = log_path()?;
    ensure_parent(&path)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{message}").map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn read_recent_log_lines(limit: usize) -> Result<Vec<String>, String> {
    let path = log_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let reader = BufReader::new(file);
    let mut lines = reader
        .lines()
        .map(|line| line.unwrap_or_default())
        .collect::<Vec<_>>();
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    Ok(lines)
}

#[tauri::command]
fn open_target(target: String) -> Result<(), String> {
    let path = expand_home_path(&target).unwrap_or_else(|_| PathBuf::from(&target));
    let open_target = if path.exists() { path.to_string_lossy().to_string() } else { target };
    if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", "start", "", &open_target])
            .spawn()
            .map_err(|error| error.to_string())?;
    } else if cfg!(target_os = "macos") {
        Command::new("open")
            .arg(&open_target)
            .spawn()
            .map_err(|error| error.to_string())?;
    } else {
        Command::new("xdg-open")
            .arg(&open_target)
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let datetime = time::OffsetDateTime::from_unix_timestamp(now as i64).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    datetime.format(&time::format_description::well_known::Rfc3339).unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_persisted_state,
            save_persisted_state,
            auth_file_exists,
            read_auth_file,
            write_auth_file,
            append_log_line,
            read_recent_log_lines,
            open_target,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
