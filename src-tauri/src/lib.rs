mod sftp_manager;
mod ssh_manager;

use serde::{Deserialize, Serialize};
use ssh_manager::{SftpSession, SshManager, TransferManager};
use std::collections::HashMap;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::async_runtime;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub key_path: Option<String>,
    /// Whether the password is stored in macOS Keychain (not in this file)
    pub has_keychain_secret: bool,
}

#[derive(Debug, Serialize)]
pub struct LocalFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub permissions: String,
    pub modified: String,
    pub owner: String,
    pub group: String,
}

/// Three separate SFTP/session pools so terminal I/O, quick file ops and
/// long transfers never contend with each other.
struct AppState {
    connections: Mutex<SshManager>,
    transfers: Arc<Mutex<TransferManager>>,
    quick: Arc<Mutex<TransferManager>>,
    cancel_tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
    transfer_sessions: Arc<Mutex<HashMap<String, String>>>,
    active_transfers: Arc<Mutex<usize>>, // max 2 concurrent (queued)
    remote_cpu_ticks: Mutex<HashMap<String, Vec<u64>>>, // per-session previous CPU ticks
    remote_network_prev: Mutex<HashMap<String, (u64, u64, Instant)>>, // per-session network deltas
}

// ── macOS Keychain helpers ──

fn keychain_service() -> &'static str {
    "com.weterm.ssh"
}

fn save_to_keychain(username: &str, host: &str, password: &str) -> Result<(), String> {
    let account = format!("{}@{}", username, host);
    // Delete existing entry first, then add
    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            &account,
            "-s",
            keychain_service(),
        ])
        .output();
    let out = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            &account,
            "-s",
            keychain_service(),
            "-w",
            password,
            "-U",
        ])
        .output()
        .map_err(|e| format!("keychain: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "keychain add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

fn get_from_keychain(username: &str, host: &str) -> Result<String, String> {
    let account = format!("{}@{}", username, host);
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            &account,
            "-s",
            keychain_service(),
            "-w",
        ])
        .output()
        .map_err(|e| format!("keychain: {}", e))?;
    if !out.status.success() {
        return Err("Password not found in keychain".into());
    }
    String::from_utf8(out.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| e.to_string())
}

fn delete_from_keychain(username: &str, host: &str) {
    let account = format!("{}@{}", username, host);
    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            &account,
            "-s",
            keychain_service(),
        ])
        .output();
}

fn connections_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "No HOME")?;
    let dir = std::path::Path::new(&home).join(".weterm");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connections.json"))
}

#[tauri::command]
async fn save_connections(list: Vec<SavedConnection>) -> Result<(), String> {
    let p = connections_path()?;
    let s = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(&p, s).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_connections() -> Result<Vec<SavedConnection>, String> {
    let p = connections_path()?;
    if !p.exists() {
        return Ok(Vec::new());
    }
    let s = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

// ── Terminal commands (connections lock) ──

#[tauri::command]
async fn ssh_connect(
    state: State<'_, Arc<AppState>>,
    id: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    key_path: Option<String>,
) -> Result<String, String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        // Connect main (terminal) session
        let home = {
            let mut mgr = state.connections.lock().map_err(|e| e.to_string())?;
            mgr.connect(
                &id,
                &host,
                port,
                &username,
                password.as_deref(),
                key_path.as_deref(),
            )?
        };
        // Dedicated transfer session and a separate quick SFTP session so
        // long transfers never block terminal or file browsing.
        let sftp_sess = match SftpSession::connect(
            &host,
            port,
            &username,
            password.as_deref(),
            key_path.as_deref(),
        ) {
            Ok(s) => s,
            Err(e) => {
                let _ = state
                    .connections
                    .lock()
                    .map_err(|e| e.to_string())?
                    .disconnect(&id);
                return Err(e);
            }
        };
        let quick_sess = match SftpSession::connect(
            &host,
            port,
            &username,
            password.as_deref(),
            key_path.as_deref(),
        ) {
            Ok(s) => s,
            Err(e) => {
                let _ = state
                    .connections
                    .lock()
                    .map_err(|e| e.to_string())?
                    .disconnect(&id);
                let _ = state
                    .transfers
                    .lock()
                    .map_err(|e| e.to_string())?
                    .remove(&id);
                return Err(e);
            }
        };
        state
            .transfers
            .lock()
            .map_err(|e| e.to_string())?
            .add(&id, sftp_sess);
        state
            .quick
            .lock()
            .map_err(|e| e.to_string())?
            .add(&id, quick_sess);
        Ok(home)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_disconnect(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        // Cancel every transfer belonging to this session first.
        let tids: Vec<String> = {
            let map = state.transfer_sessions.lock().map_err(|e| e.to_string())?;
            map.iter()
                .filter(|(_, sid)| *sid == &id)
                .map(|(tid, _)| tid.clone())
                .collect()
        };
        for tid in &tids {
            let tokens = state.cancel_tokens.lock().map_err(|e| e.to_string())?;
            if let Some(token) = tokens.get(tid) {
                token.store(true, Ordering::SeqCst);
            }
        }
        {
            let mut map = state.transfer_sessions.lock().map_err(|e| e.to_string())?;
            for tid in &tids {
                map.remove(tid);
            }
        }
        state
            .connections
            .lock()
            .map_err(|e| e.to_string())?
            .disconnect(&id)?;
        state
            .transfers
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id);
        state.quick.lock().map_err(|e| e.to_string())?.remove(&id);
        // Clean up remote CPU ticks to prevent memory leak
        state
            .remote_cpu_ticks
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id);
        state
            .remote_network_prev
            .lock()
            .map_err(|e| e.to_string())?
            .remove(&id);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_execute(
    state: State<'_, Arc<AppState>>,
    id: String,
    command: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let mut mgr = state.connections.lock().map_err(|e| e.to_string())?;
        mgr.execute(&id, &command)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_terminal_write(
    state: State<'_, Arc<AppState>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let mut mgr = state.connections.lock().map_err(|e| e.to_string())?;
        mgr.shell_write(&id, &data)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_terminal_read(state: State<'_, Arc<AppState>>, id: String) -> Result<String, String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let mut mgr = state.connections.lock().map_err(|e| e.to_string())?;
        mgr.shell_read(&id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_terminal_resize(
    state: State<'_, Arc<AppState>>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let mut mgr = state.connections.lock().map_err(|e| e.to_string())?;
        mgr.shell_resize(&id, cols, rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Quick SFTP ops (dedicated quick session — never touches terminal or transfers) ──

#[tauri::command]
async fn sftp_list_files(
    state: State<'_, Arc<AppState>>,
    id: String,
    path: String,
) -> Result<Vec<sftp_manager::FileEntry>, String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let sess = state.quick.lock().map_err(|e| e.to_string())?.get(&id)?;
        let sftp = sess.sftp()?;
        sftp_manager::do_list_files(&sftp, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Transfer commands (dedicated SFTP connection, never blocks terminal) ──

/// Expand ~ and ~/ in paths. Returns the resolved path with HOME substituted.
fn resolve_tilde(path: &str) -> String {
    if path.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        home + &path[1..]
    } else if path == "~" {
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
    } else {
        path.to_string()
    }
}

/// Expand ~ in local paths and ensure parent directories exist.
fn expand_local(path: &str) -> Result<String, String> {
    let expanded = resolve_tilde(path);
    if let Some(parent) = std::path::Path::new(&expanded).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    Ok(expanded)
}

#[tauri::command]
async fn sftp_download(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    // Create cancel token before spawning thread (so frontend can cancel immediately)
    let token = ensure_cancel_token(&state.cancel_tokens, &transfer_id)?;
    let local_expanded = expand_local(&local_path)?;
    let sess = {
        let mgr = state.transfers.lock().map_err(|e| e.to_string())?;
        mgr.get(&id)?
    };
    let active = Arc::clone(&state.active_transfers);
    let tid = transfer_id.clone();
    let rp = remote_path.clone();
    let le = local_expanded.clone();
    state
        .transfer_sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(transfer_id.clone(), id.clone());
    let ts_sessions = Arc::clone(&state.transfer_sessions);

    std::thread::spawn(move || {
        // Wait for queue slot inside the background thread (non-blocking for Tauri)
        let _guard = match wait_for_slot(&active, &token) {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit(
                    "transfer-complete",
                    serde_json::json!({
                        "id": tid, "success": false, "error": e,
                    }),
                );
                let _ = ts_sessions.lock().map(|mut m| m.remove(&tid));
                return;
            }
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            TransferManager::download(&sess, &rp, &le, &tid, &app, &token)
        }));
        let final_result = match result {
            Ok(r) => r,
            Err(_) => Err("Transfer thread panicked".into()),
        };
        let _ = app.emit(
            "transfer-complete",
            serde_json::json!({
                "id": tid,
                "success": final_result.is_ok(),
                "error": final_result.as_ref().err().map(|e| e.as_str()).unwrap_or(""),
            }),
        );
        let _ = ts_sessions.lock().map(|mut m| m.remove(&tid));
    });

    Ok(())
}

/// Launch an upload in a background thread. Command returns immediately.
#[tauri::command]
async fn sftp_upload(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let token = ensure_cancel_token(&state.cancel_tokens, &transfer_id)?;
    let local_expanded = expand_local(&local_path)?;
    let sess = {
        let mgr = state.transfers.lock().map_err(|e| e.to_string())?;
        mgr.get(&id)?
    };
    let active = Arc::clone(&state.active_transfers);
    let tid = transfer_id.clone();
    let rp = remote_path.clone();
    let le = local_expanded.clone();
    state
        .transfer_sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(transfer_id.clone(), id.clone());
    let ts_sessions = Arc::clone(&state.transfer_sessions);

    std::thread::spawn(move || {
        let _guard = match wait_for_slot(&active, &token) {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit(
                    "transfer-complete",
                    serde_json::json!({
                        "id": tid, "success": false, "error": e,
                    }),
                );
                let _ = ts_sessions.lock().map(|mut m| m.remove(&tid));
                return;
            }
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            TransferManager::upload(&sess, &le, &rp, &tid, &app, &token)
        }));
        let final_result = match result {
            Ok(r) => r,
            Err(_) => Err("Transfer thread panicked".into()),
        };
        let _ = app.emit(
            "transfer-complete",
            serde_json::json!({
                "id": tid,
                "success": final_result.is_ok(),
                "error": final_result.as_ref().err().map(|e| e.as_str()).unwrap_or(""),
            }),
        );
        let _ = ts_sessions.lock().map(|mut m| m.remove(&tid));
    });

    Ok(())
}

/// Folder download (recursive). Command returns immediately.
#[tauri::command]
async fn sftp_download_dir(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let token = ensure_cancel_token(&state.cancel_tokens, &transfer_id)?;
    let lp = expand_local(&local_path)?;
    let sess = {
        let mgr = state.transfers.lock().map_err(|e| e.to_string())?;
        mgr.get(&id)?
    };
    let active = Arc::clone(&state.active_transfers);
    let tid = transfer_id.clone();
    let rp = remote_path.clone();
    state
        .transfer_sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(transfer_id.clone(), id.clone());
    let ts_sessions = Arc::clone(&state.transfer_sessions);
    std::thread::spawn(move || {
        let _guard = match wait_for_slot(&active, &token) {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit(
                    "transfer-complete",
                    serde_json::json!({
                        "id": tid, "success": false, "error": e,
                    }),
                );
                let _ = ts_sessions.lock().map(|mut m| m.remove(&tid));
                return;
            }
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            TransferManager::download_dir(&sess, &rp, &lp, &tid, &app, &token)
        }));
        let final_result = match result {
            Ok(r) => r,
            Err(_) => Err("Transfer thread panicked".into()),
        };
        let _ = app.emit(
            "transfer-complete",
            serde_json::json!({
                "id": tid, "success": final_result.is_ok(),
                "error": final_result.as_ref().err().map(|e| e.as_str()).unwrap_or(""),
            }),
        );
        let _ = ts_sessions.lock().map(|mut m| m.remove(&tid));
    });
    Ok(())
}

/// Folder upload (recursive). Command returns immediately.
#[tauri::command]
async fn sftp_upload_dir(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    id: String,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let token = ensure_cancel_token(&state.cancel_tokens, &transfer_id)?;
    let lp = expand_local(&local_path)?;
    let sess = {
        let mgr = state.transfers.lock().map_err(|e| e.to_string())?;
        mgr.get(&id)?
    };
    let active = Arc::clone(&state.active_transfers);
    let tid = transfer_id.clone();
    let rp = remote_path.clone();
    state
        .transfer_sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(transfer_id.clone(), id.clone());
    let ts_sessions = Arc::clone(&state.transfer_sessions);
    std::thread::spawn(move || {
        let _guard = match wait_for_slot(&active, &token) {
            Ok(g) => g,
            Err(e) => {
                let _ = app.emit(
                    "transfer-complete",
                    serde_json::json!({
                        "id": tid, "success": false, "error": e,
                    }),
                );
                let _ = ts_sessions.lock().map(|mut m| m.remove(&tid));
                return;
            }
        };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            TransferManager::upload_dir(&sess, &lp, &rp, &tid, &app, &token)
        }));
        let final_result = match result {
            Ok(r) => r,
            Err(_) => Err("Transfer thread panicked".into()),
        };
        let _ = app.emit(
            "transfer-complete",
            serde_json::json!({
                "id": tid, "success": final_result.is_ok(),
                "error": final_result.as_ref().err().map(|e| e.as_str()).unwrap_or(""),
            }),
        );
        let _ = ts_sessions.lock().map(|mut m| m.remove(&tid));
    });
    Ok(())
}

/// RAII guard: decrements the active transfer count on drop (panic-safe).
struct TransferGuard {
    active: Arc<Mutex<usize>>,
}
impl Drop for TransferGuard {
    fn drop(&mut self) {
        if let Ok(mut count) = self.active.lock() {
            *count = count.saturating_sub(1);
        }
    }
}

/// Wait for a transfer slot (max 1 concurrent). Safe to call from any thread.
/// Polls every 500ms. Returns a guard that decrements the count on drop.
fn wait_for_slot(
    active: &Arc<Mutex<usize>>,
    token: &Arc<AtomicBool>,
) -> Result<TransferGuard, String> {
    loop {
        if token.load(Ordering::SeqCst) {
            return Err("Cancelled before start".into());
        }
        let acquired = {
            let mut count = active.lock().map_err(|e| e.to_string())?;
            if *count < 2 {
                *count += 1;
                true
            } else {
                false
            }
        };
        if acquired {
            return Ok(TransferGuard {
                active: Arc::clone(active),
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

/// Get or create a cancel token for a transfer (returns before thread spawn).
fn ensure_cancel_token(
    tokens: &Mutex<HashMap<String, Arc<AtomicBool>>>,
    transfer_id: &str,
) -> Result<Arc<AtomicBool>, String> {
    let mut map = tokens.lock().map_err(|e| e.to_string())?;
    Ok(map
        .entry(transfer_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone())
}

#[tauri::command]
async fn cancel_transfer(
    state: State<'_, Arc<AppState>>,
    transfer_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let _ = ensure_cancel_token(&state.cancel_tokens, &transfer_id)?;
        let tokens = state.cancel_tokens.lock().map_err(|e| e.to_string())?;
        if let Some(token) = tokens.get(&transfer_id) {
            token.store(true, Ordering::SeqCst);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Returns accurate CPU% using kern.cp_times delta between calls.
/// First call returns 0 (no baseline); subsequent calls return actual usage.
fn get_cpu_percent() -> f64 {
    fn tracker() -> &'static Mutex<(Vec<u64>, Instant)> {
        static TRACKER: OnceLock<Mutex<(Vec<u64>, Instant)>> = OnceLock::new();
        TRACKER.get_or_init(|| Mutex::new((Vec::new(), Instant::now())))
    }

    let out = Command::new("sysctl")
        .args(["-n", "kern.cp_times"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let ticks: Vec<u64> = out
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();

    // Expected: 4 values per core (USER, NICE, SYS, IDLE). Skip if malformed.
    if ticks.is_empty() || ticks.len() % 4 != 0 {
        return 0.0;
    }

    let now = Instant::now();
    let mut last = tracker().lock().unwrap();

    let pct = if !last.0.is_empty() && last.0.len() == ticks.len() {
        let elapsed = now.duration_since(last.1).as_secs_f64();
        if elapsed > 0.0 {
            let mut total_delta = 0u64;
            let mut idle_delta = 0u64;
            for (i, &v) in ticks.iter().enumerate() {
                let delta = v.saturating_sub(last.0[i]);
                total_delta += delta;
                if i % 4 == 3 {
                    idle_delta += delta;
                } // CP_IDLE is every 4th value
            }
            if total_delta > 0 {
                100.0 * (1.0 - idle_delta as f64 / total_delta as f64)
            } else {
                0.0
            }
        } else {
            0.0
        }
    } else {
        0.0
    };

    last.0 = ticks;
    last.1 = now;
    pct
}

#[tauri::command]
async fn get_system_info() -> Result<String, String> {
    async_runtime::spawn_blocking(|| {
        let cpu = format!("{:.1}", get_cpu_percent());
        let mem = Command::new("sh")
            .arg("-c")
            .arg("vm_stat 2>/dev/null | awk '/Pages active/ {a=int($NF)} /Pages wired down/ {w=int($NF)} END {printf \"%.1f\", (a+w)*4096/1073741824}'")
            .output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "--".to_string());
        let total_mem = Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output().ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .and_then(|s| s.parse::<f64>().ok().map(|b| format!("{:.1}", b / 1073741824.0)))
            .unwrap_or_else(|| "--".to_string());
        Ok(format!("{}|{}|{}", cpu, mem, total_mem))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read network interface byte counters for all en* interfaces (macOS).
fn get_local_network_bytes() -> (u64, u64) {
    let out = Command::new("sh")
        .arg("-c")
        .arg("netstat -ibn 2>/dev/null | awk '/^en[0-9]+ /{rx+=$7;tx+=$10} END{printf \"%d %d\",rx,tx}'")
        .output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let mut parts = out.split_whitespace();
    let rx: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let tx: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (rx, tx)
}

fn parse_ps_output(raw: &str) -> Vec<ProcessInfo> {
    let mut procs = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, ' ');
        let pid: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        let cpu: f64 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        let mem: f64 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(v) => v,
            None => continue,
        };
        let name = parts.next().unwrap_or("?").trim().to_string();
        procs.push(ProcessInfo {
            pid,
            name,
            cpu_percent: cpu,
            mem_percent: mem,
        });
    }
    procs
}

fn collect_local_monitor_data(
    prev_rx: &mut u64,
    prev_tx: &mut u64,
    prev_time: &mut Instant,
) -> MonitorData {
    let cpu = get_cpu_percent();
    let mem_used = Command::new("sh")
        .arg("-c")
        .arg("vm_stat 2>/dev/null | awk '/Pages active/ {a=int($NF)} /Pages wired down/ {w=int($NF)} END {printf \"%.1f\", (a+w)*4096/1073741824}'")
        .output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f64>().unwrap_or(0.0))
        .unwrap_or(0.0);
    let mem_total = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .and_then(|s| s.parse::<f64>().ok().map(|b| b / 1073741824.0))
        .unwrap_or(0.0);

    let (rx, tx) = get_local_network_bytes();
    let now = Instant::now();
    let elapsed = now.duration_since(*prev_time).as_secs_f64();
    let rx_speed = if elapsed > 0.0 {
        rx.saturating_sub(*prev_rx) as f64 / elapsed
    } else {
        0.0
    };
    let tx_speed = if elapsed > 0.0 {
        tx.saturating_sub(*prev_tx) as f64 / elapsed
    } else {
        0.0
    };
    *prev_rx = rx;
    *prev_tx = tx;
    *prev_time = now;

    let ps_raw = Command::new("sh")
        .arg("-c")
        .arg("ps -Ao pid,pcpu,pmem,comm -r 2>/dev/null | head -11 | tail -10")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let procs = parse_ps_output(&ps_raw);

    MonitorData {
        cpu_percent: (cpu * 10.0).round() / 10.0,
        mem_used_gb: (mem_used * 10.0).round() / 10.0,
        mem_total_gb: (mem_total * 10.0).round() / 10.0,
        net_rx_bytes_per_sec: (rx_speed * 10.0).round() / 10.0,
        net_tx_bytes_per_sec: (tx_speed * 10.0).round() / 10.0,
        top_processes: procs,
    }
}

/// Module-level stop flag for the local monitor thread.
static MONITOR_RUNNING: OnceLock<Arc<AtomicBool>> = OnceLock::new();

#[tauri::command]
async fn start_monitor(app: AppHandle) {
    let running = MONITOR_RUNNING.get_or_init(|| Arc::new(AtomicBool::new(false)));
    if running.load(Ordering::SeqCst) {
        return;
    } // already running
    running.store(true, Ordering::SeqCst);
    let running_clone = Arc::clone(running);

    std::thread::spawn(move || {
        let mut prev_rx: u64 = 0;
        let mut prev_tx: u64 = 0;
        let mut prev_time = Instant::now();
        // First call: just establish baseline (no valid delta yet)
        let _ = get_local_network_bytes(); // seed network counters
                                           // Skip first tick — we need two samples for delta
        while running_clone.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            if !running_clone.load(Ordering::SeqCst) {
                break;
            }
            let data = collect_local_monitor_data(&mut prev_rx, &mut prev_tx, &mut prev_time);
            let _ = app.emit("monitor-data", data);
        }
    });
}

#[tauri::command]
async fn stop_monitor() {
    if let Some(running) = MONITOR_RUNNING.get() {
        running.store(false, Ordering::SeqCst);
    }
}

// ── Activity history persistence (per host) ──

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntryData {
    pub id: String,
    pub r#type: String, // "command" | "download" | "upload"
    pub timestamp: u64,
    pub detail: String,
}

// ── System monitoring data ──

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f64,
    pub mem_percent: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonitorData {
    pub cpu_percent: f64,
    pub mem_used_gb: f64,
    pub mem_total_gb: f64,
    pub net_rx_bytes_per_sec: f64,
    pub net_tx_bytes_per_sec: f64,
    pub top_processes: Vec<ProcessInfo>,
}

fn activity_path(
    base_path: &str,
    host: &str,
    username: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = std::path::PathBuf::from(resolve_tilde(base_path));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{}@{}.json", username, host)))
}

#[tauri::command]
async fn load_activity_history(
    base_path: String,
    host: String,
    username: String,
) -> Result<Vec<ActivityEntryData>, String> {
    async_runtime::spawn_blocking(move || {
        let p = activity_path(&base_path, &host, &username)?;
        if !p.exists() {
            return Ok(Vec::new());
        }
        let s = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_activity_history(
    base_path: String,
    host: String,
    username: String,
    entries: Vec<ActivityEntryData>,
) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let p = activity_path(&base_path, &host, &username)?;
        let s = serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?;
        std::fs::write(&p, s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Remote system info (per-session) ──

#[tauri::command]
async fn get_remote_system_info(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
    let mut mgr = state.connections.lock().map_err(|e| e.to_string())?;

    // Read /proc/stat CPU line (raw ticks: user nice system idle iowait irq softirq steal)
    let cpu_line = mgr.execute(&id, "head -1 /proc/stat 2>/dev/null || echo ''")?;
    let ticks: Vec<u64> = cpu_line
        .split_whitespace()
        .skip(1) // skip "cpu"
        .filter_map(|s| s.parse().ok())
        .collect();

    // Read memory info: used|total
    let mem_raw = mgr.execute(&id,
        "awk '/MemTotal:/{mt=$2} /MemAvailable:/{ma=$2} END{if(mt>0) printf \"%.1f|%.1f\",(mt-ma)/1048576,mt/1048576; else print \"--|--\"}' /proc/meminfo 2>/dev/null || echo '--|--'")?;
    let mem_str = mem_raw.trim().to_string();

    // Delta CPU calculation: compare current ticks with previous call's ticks
    let cpu_str = {
        let mut prev_map = state.remote_cpu_ticks.lock().map_err(|e| e.to_string())?;
        let prev = prev_map.get(&id);
        let pct = match prev {
            Some(prev_ticks) if prev_ticks.len() == ticks.len() && ticks.len() >= 4 => {
                let mut total_delta = 0u64;
                let mut idle_delta = 0u64;
                for (i, &v) in ticks.iter().enumerate() {
                    let delta = v.saturating_sub(prev_ticks[i]);
                    total_delta += delta;
                    // CP_IDLE is index 3 in the first 4 values
                    if i == 3 { idle_delta += delta; }
                }
                // Also include iowait (index 4) as idle if present
                if ticks.len() > 4 {
                    idle_delta += ticks[4].saturating_sub(prev_ticks[4]);
                }
                if total_delta > 0 {
                    format!("{:.1}", 100.0 * (1.0 - idle_delta as f64 / total_delta as f64))
                } else {
                    "--".to_string()
                }
            }
            _ => "--".to_string(),
        };
        prev_map.insert(id.clone(), ticks);
        pct
    };

    Ok(format!("{}|{}", cpu_str, mem_str))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_remote_monitor_data(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<MonitorData, String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
    let mut mgr = state.connections.lock().map_err(|e| e.to_string())?;

    // CPU: reuse /proc/stat delta logic (same as get_remote_system_info)
    let cpu_line = mgr.execute(&id, "head -1 /proc/stat 2>/dev/null || echo ''")?;
    let ticks: Vec<u64> = cpu_line
        .split_whitespace()
        .skip(1)
        .filter_map(|s| s.parse().ok())
        .collect();
    let cpu_pct = {
        let mut prev_map = state.remote_cpu_ticks.lock().map_err(|e| e.to_string())?;
        let prev = prev_map.get(&id);
        let pct = match prev {
            Some(prev_ticks) if prev_ticks.len() == ticks.len() && ticks.len() >= 4 => {
                let mut total_delta = 0u64;
                let mut idle_delta = 0u64;
                for (i, &v) in ticks.iter().enumerate() {
                    let delta = v.saturating_sub(prev_ticks[i]);
                    total_delta += delta;
                    if i == 3 { idle_delta += delta; }
                }
                if ticks.len() > 4 {
                    idle_delta += ticks[4].saturating_sub(prev_ticks[4]);
                }
                if total_delta > 0 {
                    100.0 * (1.0 - idle_delta as f64 / total_delta as f64)
                } else { 0.0 }
            }
            _ => 0.0,
        };
        prev_map.insert(id.clone(), ticks);
        pct
    };

    // Memory: same awk as get_remote_system_info but return f64
    let mem_raw = mgr.execute(&id,
        "awk '/MemTotal:/{mt=$2} /MemAvailable:/{ma=$2} END{if(mt>0) printf \"%.1f|%.1f\",(mt-ma)/1048576,mt/1048576; else print \"0|0\"}' /proc/meminfo 2>/dev/null || echo '0|0'")?;
    let mem_parts: Vec<f64> = mem_raw.trim().split('|')
        .filter_map(|s| s.parse().ok()).collect();
    let (mem_used, mem_total) = if mem_parts.len() >= 2 {
        (mem_parts[0], mem_parts[1])
    } else { (0.0, 0.0) };

    // Network: /proc/net/dev, first active eth/ens/enp/wlan interface
    let net_raw = mgr.execute(&id,
        "cat /proc/net/dev 2>/dev/null | awk 'NR>2 && $1 ~ /^(eth|ens|enp|wlan)/{gsub(/:/,\"\",$1); print $2,$10; exit}' || echo '0 0'")?;
    let net_parts: Vec<u64> = net_raw.trim().split_whitespace()
        .filter_map(|s| s.parse().ok()).collect();
    let (rx, tx) = if net_parts.len() >= 2 {
        (net_parts[0], net_parts[1])
    } else { (0, 0) };

    let now = Instant::now();
    let (rx_speed, tx_speed) = {
        let mut prev_map = state.remote_network_prev.lock().map_err(|e| e.to_string())?;
        let (rs, ts) = if let Some(&(prx, ptx, ptime)) = prev_map.get(&id) {
            let elapsed = now.duration_since(ptime).as_secs_f64();
            if elapsed > 0.0 {
                let rd = rx.saturating_sub(prx) as f64 / elapsed;
                let td = tx.saturating_sub(ptx) as f64 / elapsed;
                (rd, td)
            } else { (0.0, 0.0) }
        } else { (0.0, 0.0) };
        prev_map.insert(id.clone(), (rx, tx, now));
        (rs, ts)
    };

    // Top processes
    let ps_raw = mgr.execute(&id,
        "ps -eo pid,pcpu,pmem,comm --sort=-pcpu --no-headers 2>/dev/null | head -10 || echo ''")?;
    let procs = parse_ps_output(&ps_raw);

    Ok(MonitorData {
        cpu_percent: (cpu_pct * 10.0).round() / 10.0,
        mem_used_gb: (mem_used * 10.0).round() / 10.0,
        mem_total_gb: (mem_total * 10.0).round() / 10.0,
        net_rx_bytes_per_sec: (rx_speed * 10.0).round() / 10.0,
        net_tx_bytes_per_sec: (tx_speed * 10.0).round() / 10.0,
        top_processes: procs,
    })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Settings persistence ──

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_true")]
    pub show_commands_tab: bool,
    #[serde(default = "default_true")]
    pub show_tasks_tab: bool,
    #[serde(default = "default_max_saved")]
    pub max_saved_entries: usize,
    #[serde(default = "default_max_display")]
    pub max_display_entries: usize,
    #[serde(default = "default_true")]
    pub show_cpu: bool,
    #[serde(default = "default_true")]
    pub show_mem: bool,
    #[serde(default = "default_true")]
    pub show_login_time: bool,
    #[serde(default = "default_true")]
    pub show_duration: bool,
    // Status bar style: "text" or "circles"
    #[serde(default = "default_status_style")]
    pub status_style: String,
    // Theme & fonts
    #[serde(default = "default_theme")]
    pub theme: String, // "dark" | "light" | "system" | "custom"
    #[serde(default)]
    pub custom_colors: Option<String>, // JSON: {"--bg":"#...", ...}
    #[serde(default = "default_ui_font_family")]
    pub ui_font_family: String,
    #[serde(default = "default_terminal_font_family")]
    pub terminal_font_family: String,
    #[serde(default = "default_notepad_font_family")]
    pub notepad_font_family: String,
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: u32,
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: u32,
    #[serde(default = "default_notepad_font_size")]
    pub notepad_font_size: u32,
    // File metadata display
    #[serde(default = "default_true")]
    pub show_file_meta: bool,
    #[serde(default = "default_true")]
    pub show_file_permissions: bool,
    #[serde(default = "default_true")]
    pub show_file_owner: bool,
    #[serde(default = "default_true")]
    pub show_file_modified: bool,
    #[serde(default = "default_true")]
    pub show_file_size: bool,
    // Notepad
    #[serde(default = "default_true")]
    pub show_notepad_tab: bool,
    #[serde(default = "default_notepad_save_path")]
    pub notepad_save_path: String,
    // Activity/record save path
    #[serde(default = "default_activity_save_path")]
    pub activity_save_path: String,
    // Monitor panel
    #[serde(default = "default_true")]
    pub show_monitor_tab: bool,
    // Terminal background color (default: pure black)
    #[serde(default = "default_terminal_bg_color")]
    pub terminal_bg_color: String,
    // Terminal foreground/text color (default: near-white)
    #[serde(default = "default_terminal_fg_color")]
    pub terminal_fg_color: String,
}

fn default_true() -> bool {
    true
}
fn default_max_saved() -> usize {
    10000
}
fn default_max_display() -> usize {
    50
}
fn default_theme() -> String {
    "dark".into()
}
fn default_terminal_font_size() -> u32 {
    13
}
fn default_ui_font_size() -> u32 {
    13
}
fn default_notepad_font_size() -> u32 {
    11
}
fn default_ui_font_family() -> String {
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif".into()
}
fn default_terminal_font_family() -> String {
    "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace".into()
}
fn default_notepad_font_family() -> String {
    "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace".into()
}
fn default_notepad_save_path() -> String {
    "~/.weterm/notepad".into()
}
fn default_status_style() -> String {
    "text".into()
}
fn default_activity_save_path() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    format!("{}/.weterm/activity", home)
}
fn default_terminal_bg_color() -> String {
    "#000000".into()
}
fn default_terminal_fg_color() -> String {
    "#f5f5f7".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            show_commands_tab: true,
            show_tasks_tab: true,
            max_saved_entries: 10000,
            max_display_entries: 50,
            show_cpu: true,
            show_mem: true,
            show_login_time: true,
            show_duration: true,
            status_style: default_status_style(),
            theme: "dark".into(),
            custom_colors: None,
            ui_font_family: default_ui_font_family(),
            terminal_font_family: default_terminal_font_family(),
            notepad_font_family: default_notepad_font_family(),
            terminal_font_size: 13,
            ui_font_size: 13,
            notepad_font_size: 11,
            show_file_meta: true,
            show_file_permissions: true,
            show_file_owner: true,
            show_file_modified: true,
            show_file_size: true,
            show_notepad_tab: true,
            notepad_save_path: default_notepad_save_path(),
            activity_save_path: default_activity_save_path(),
            show_monitor_tab: true,
            terminal_bg_color: "#000000".into(),
            terminal_fg_color: "#f5f5f7".into(),
        }
    }
}

fn settings_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "No HOME")?;
    let dir = std::path::Path::new(&home).join(".weterm");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
async fn load_settings() -> Result<AppSettings, String> {
    let p = settings_path()?;
    if !p.exists() {
        return Ok(AppSettings::default());
    }
    let s = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_settings(settings: AppSettings) -> Result<(), String> {
    let p = settings_path()?;
    let s = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&p, s).map_err(|e| e.to_string())
}

// ── Keychain commands ──

#[tauri::command]
async fn keychain_save(username: String, host: String, password: String) -> Result<(), String> {
    save_to_keychain(&username, &host, &password)
}

#[tauri::command]
async fn keychain_get(username: String, host: String) -> Result<String, String> {
    get_from_keychain(&username, &host)
}

#[tauri::command]
async fn keychain_delete(username: String, host: String) -> Result<(), String> {
    delete_from_keychain(&username, &host);
    Ok(())
}

#[tauri::command]
async fn clear_known_hosts() -> Result<(), String> {
    async_runtime::spawn_blocking(ssh_manager::clear_known_hosts)
        .await
        .map_err(|e| e.to_string())?
}

// ── SFTP utility commands (also on connections lock) ──

#[tauri::command]
async fn sftp_read_file(
    state: State<'_, Arc<AppState>>,
    id: String,
    path: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let sess = state.quick.lock().map_err(|e| e.to_string())?.get(&id)?;
        let sftp = sess.sftp()?;
        let mut f = sftp
            .open(std::path::Path::new(&path))
            .map_err(|e| e.to_string())?;
        let mut content = String::new();
        std::io::Read::read_to_string(&mut f, &mut content).map_err(|e| e.to_string())?;
        Ok(content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sftp_write_file(
    state: State<'_, Arc<AppState>>,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let sess = state.quick.lock().map_err(|e| e.to_string())?.get(&id)?;
        let sftp = sess.sftp()?;
        let mut f = sftp
            .create(std::path::Path::new(&path))
            .map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut f, content.as_bytes()).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sftp_delete(
    state: State<'_, Arc<AppState>>,
    id: String,
    path: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let sess = state.quick.lock().map_err(|e| e.to_string())?.get(&id)?;
        let sftp = sess.sftp()?;
        sftp_manager::do_delete(&sftp, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sftp_create_dir(
    state: State<'_, Arc<AppState>>,
    id: String,
    path: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let sess = state.quick.lock().map_err(|e| e.to_string())?.get(&id)?;
        let sftp = sess.sftp()?;
        sftp_manager::do_create_dir(&sftp, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, Arc<AppState>>,
    id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let sess = state.quick.lock().map_err(|e| e.to_string())?.get(&id)?;
        let sftp = sess.sftp()?;
        sftp_manager::do_rename(&sftp, &old_path, &new_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Local file commands ──

#[tauri::command]
async fn local_list_files(path: String) -> Result<Vec<LocalFileEntry>, String> {
    async_runtime::spawn_blocking(move || {
        let expanded = resolve_tilde(&path);
        let dir = std::path::Path::new(&expanded);
        if !dir.is_dir() {
            return Err(format!("Not a dir: {}", expanded));
        }
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let e = entry.map_err(|e| e.to_string())?;
            let m = e.metadata().map_err(|e| e.to_string())?;
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| {
                    let secs = d.as_secs();
                    let days = secs / 86400;
                    let mut y = 1970i64;
                    let mut rem = days as i64;
                    loop {
                        let yd = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                            366
                        } else {
                            365
                        };
                        if rem < yd {
                            break;
                        }
                        rem -= yd;
                        y += 1;
                    }
                    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
                    let md: [i64; 12] = [
                        31,
                        if leap { 29 } else { 28 },
                        31,
                        30,
                        31,
                        30,
                        31,
                        31,
                        30,
                        31,
                        30,
                        31,
                    ];
                    let mut mo = 0usize;
                    for (i, &mdv) in md.iter().enumerate() {
                        if rem < mdv {
                            mo = i + 1;
                            break;
                        }
                        rem -= mdv;
                    }
                    format!(
                        "{:04}-{:02}-{:02} {:02}:{:02}",
                        y,
                        mo,
                        rem + 1,
                        (secs / 3600) % 24,
                        (secs / 60) % 60
                    )
                })
                .unwrap_or_else(|| "--".into());
            let perm = if m.is_dir() {
                "drwxr-xr-x"
            } else {
                "rw-r--r--"
            }
            .to_string();
            entries.push(LocalFileEntry {
                name: e.file_name().to_string_lossy().into(),
                path: e.path().to_string_lossy().into(),
                is_dir: m.is_dir(),
                size: m.len(),
                permissions: perm,
                modified,
                owner: "--".into(),
                group: "--".into(),
            });
        }
        entries.sort_by(|a, b| {
            let ah = a.name.starts_with('.');
            let bh = b.name.starts_with('.');
            if a.is_dir != b.is_dir {
                return b.is_dir.cmp(&a.is_dir);
            }
            if ah != bh {
                return ah.cmp(&bh);
            }
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        });
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_home_dir() -> Result<String, String> {
    async_runtime::spawn_blocking(|| std::env::var("HOME").map_err(|_| "No HOME".to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn local_delete(path: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let expanded = resolve_tilde(&path);
        let p = std::path::Path::new(&expanded);
        if p.is_dir() {
            std::fs::remove_dir_all(p).map_err(|e| e.to_string())
        } else if p.is_file() {
            std::fs::remove_file(p).map_err(|e| e.to_string())
        } else {
            Err(format!("Not found: {}", expanded))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn local_create_dir(path: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let expanded = resolve_tilde(&path);
        std::fs::create_dir_all(&expanded).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn local_rename(old_path: String, new_path: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let old = resolve_tilde(&old_path);
        let new = resolve_tilde(&new_path);
        std::fs::rename(&old, &new).map_err(|e| format!("Failed to rename: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn local_read_file(path: String) -> Result<String, String> {
    async_runtime::spawn_blocking(move || {
        let expanded = resolve_tilde(&path);
        std::fs::read_to_string(&expanded).map_err(|e| format!("Read failed: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Recording (Recap) commands ──

fn recordings_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "No HOME")?;
    let dir = std::path::Path::new(&home)
        .join(".weterm")
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct RecordingEvent {
    t: u64,
    d: String,
    #[serde(rename = "type")]
    ev_type: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RecordingMeta {
    id: String,
    name: String,
    session: String,
    started_at: u64,
    events: Vec<RecordingEvent>,
}

#[tauri::command]
async fn save_recording(
    id: String,
    name: String,
    session: String,
    started_at: u64,
    events: Vec<RecordingEvent>,
) -> Result<(), String> {
    let dir = recordings_dir()?;
    let meta = RecordingMeta {
        id: id.clone(),
        name,
        session,
        started_at,
        events,
    };
    let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", id));
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct RecordingSummary {
    id: String,
    name: String,
    session: String,
    started_at: u64,
    event_count: usize,
    size_bytes: u64,
}

#[tauri::command]
async fn list_recordings() -> Result<Vec<RecordingSummary>, String> {
    let dir = recordings_dir()?;
    let mut list = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(true, |e| e != "json") {
                continue;
            }
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(meta) = serde_json::from_str::<RecordingMeta>(&raw) {
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    list.push(RecordingSummary {
                        id: meta.id,
                        name: meta.name,
                        session: meta.session,
                        started_at: meta.started_at,
                        event_count: meta.events.len(),
                        size_bytes: size,
                    });
                }
            }
        }
    }
    list.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(list)
}

#[tauri::command]
async fn load_recording(id: String) -> Result<RecordingMeta, String> {
    let dir = recordings_dir()?;
    let path = dir.join(format!("{}.json", id));
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_recording(id: String) -> Result<(), String> {
    let dir = recordings_dir()?;
    let path = dir.join(format!("{}.json", id));
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

// ── Drag-out to Finder support ──

fn cache_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "No HOME")?;
    let dir = std::path::Path::new(&home).join(".weterm").join("cache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Download a remote file to local cache for drag-out to Finder.
/// Returns the local file path that can be used in a drag operation.
#[tauri::command]
async fn cache_remote_file_for_drag(
    state: State<'_, Arc<AppState>>,
    id: String,
    remote_path: String,
) -> Result<String, String> {
    let state = state.inner().clone();
    async_runtime::spawn_blocking(move || {
        let fname = std::path::Path::new(&remote_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        let local = cache_dir()?.join(&fname);
        let sess = {
            let mgr = state.transfers.lock().map_err(|e| e.to_string())?;
            mgr.get(&id)?
        };
        // Download using dedicated SFTP session (non-blocking for terminal)
        TransferManager::download_file_only(
            &sess,
            &remote_path,
            local.to_str().unwrap_or("/tmp/weterm_drag"),
        )?;
        Ok(local.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_local_file_uri(path: String) -> Result<String, String> {
    async_runtime::spawn_blocking(move || {
        let expanded = resolve_tilde(&path);
        let p = std::path::Path::new(&expanded);
        if !p.exists() {
            return Err(format!("File not found: {}", expanded));
        }
        Ok(format!("file://{}", expanded))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Custom Commands ──

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommand {
    pub id: String,
    pub name: String,
    pub command: String,
}

fn custom_commands_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "No HOME")?;
    let dir = std::path::Path::new(&home).join(".weterm");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("custom_commands.json"))
}

#[tauri::command]
async fn load_custom_commands() -> Result<Vec<CustomCommand>, String> {
    async_runtime::spawn_blocking(move || {
        let p = custom_commands_path()?;
        if !p.exists() {
            return Ok(Vec::new());
        }
        let s = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_custom_commands(commands: Vec<CustomCommand>) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let p = custom_commands_path()?;
        let s = serde_json::to_string_pretty(&commands).map_err(|e| e.to_string())?;
        std::fs::write(&p, s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Notepad persistence ──

fn resolve_notepad_dir(path: &str) -> Result<std::path::PathBuf, String> {
    let expanded = std::path::PathBuf::from(resolve_tilde(path));
    std::fs::create_dir_all(&expanded).map_err(|e| e.to_string())?;
    Ok(expanded)
}

#[derive(serde::Serialize)]
struct NotepadFileInfo {
    name: String,
    size: u64,
    modified: String,
}

#[tauri::command]
async fn list_notepad_files(dir_path: String) -> Result<Vec<NotepadFileInfo>, String> {
    async_runtime::spawn_blocking(move || {
        let dir = resolve_notepad_dir(&dir_path)?;
        let mut files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(true, |e| e != "txt") {
                    continue;
                }
                if let Ok(meta) = path.metadata() {
                    let modified = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| {
                            let secs = d.as_secs();
                            let days = secs / 86400;
                            let mut y = 1970i64;
                            let mut rem = days as i64;
                            loop {
                                let yd = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                                    366
                                } else {
                                    365
                                };
                                if rem < yd {
                                    break;
                                }
                                rem -= yd;
                                y += 1;
                            }
                            let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
                            let md: [i64; 12] = [
                                31,
                                if leap { 29 } else { 28 },
                                31,
                                30,
                                31,
                                30,
                                31,
                                31,
                                30,
                                31,
                                30,
                                31,
                            ];
                            let mut mo = 0usize;
                            for (i, &mdv) in md.iter().enumerate() {
                                if rem < mdv {
                                    mo = i + 1;
                                    break;
                                }
                                rem -= mdv;
                            }
                            format!(
                                "{:04}-{:02}-{:02} {:02}:{:02}",
                                y,
                                mo,
                                rem + 1,
                                (secs / 3600) % 24,
                                (secs / 60) % 60
                            )
                        })
                        .unwrap_or_else(|| "--".into());
                    files.push(NotepadFileInfo {
                        name: path
                            .file_name()
                            .map(|n| n.to_string_lossy().into())
                            .unwrap_or_default(),
                        size: meta.len(),
                        modified,
                    });
                }
            }
        }
        files.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_notepad(dir_path: String, file_name: String) -> Result<String, String> {
    async_runtime::spawn_blocking(move || {
        let dir = resolve_notepad_dir(&dir_path)?;
        let p = dir.join(&file_name);
        if !p.exists() {
            return Ok(String::new());
        }
        std::fs::read_to_string(&p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_notepad(dir_path: String, file_name: String, content: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let dir = resolve_notepad_dir(&dir_path)?;
        let p = dir.join(&file_name);
        // Ensure .txt extension
        let final_path = if p.extension().map_or(true, |e| e != "txt") {
            p.with_extension("txt")
        } else {
            p
        };
        std::fs::write(&final_path, &content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_notepad_file(dir_path: String, file_name: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let dir = resolve_notepad_dir(&dir_path)?;
        let p = dir.join(&file_name);
        std::fs::remove_file(&p).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_notepad(content: String, path: String) -> Result<(), String> {
    async_runtime::spawn_blocking(move || {
        let expanded = resolve_tilde(&path);
        if let Some(parent) = std::path::Path::new(&expanded).parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
        }
        std::fs::write(&expanded, &content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState {
            connections: Mutex::new(SshManager::new()),
            transfers: Arc::new(Mutex::new(TransferManager::new())),
            quick: Arc::new(Mutex::new(TransferManager::new())),
            cancel_tokens: Mutex::new(HashMap::new()),
            transfer_sessions: Arc::new(Mutex::new(HashMap::new())),
            active_transfers: Arc::new(Mutex::new(0)),
            remote_cpu_ticks: Mutex::new(HashMap::new()),
            remote_network_prev: Mutex::new(HashMap::new()),
        }))
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_disconnect,
            ssh_execute,
            ssh_terminal_write,
            ssh_terminal_read,
            ssh_terminal_resize,
            sftp_list_files,
            sftp_download,
            sftp_upload,
            sftp_download_dir,
            sftp_upload_dir,
            sftp_read_file,
            sftp_write_file,
            sftp_delete,
            sftp_create_dir,
            sftp_rename,
            local_list_files,
            get_home_dir,
            local_delete,
            local_create_dir,
            local_rename,
            local_read_file,
            save_connections,
            load_connections,
            cancel_transfer,
            get_system_info,
            keychain_save,
            keychain_get,
            keychain_delete,
            clear_known_hosts,
            load_settings,
            save_settings,
            load_activity_history,
            save_activity_history,
            get_remote_system_info,
            start_monitor,
            stop_monitor,
            get_remote_monitor_data,
            save_recording,
            list_recordings,
            load_recording,
            delete_recording,
            load_custom_commands,
            save_custom_commands,
            cache_remote_file_for_drag,
            get_local_file_uri,
            list_notepad_files,
            load_notepad,
            save_notepad,
            delete_notepad_file,
            export_notepad,
        ])
        .run(tauri::generate_context!())
        .expect("error running Weterm");
}
