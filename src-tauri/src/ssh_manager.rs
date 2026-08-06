use ssh2::{Channel, CheckResult, KnownHostFileKind, KnownHostKeyFormat, Session, Sftp};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const CONNECT_TIMEOUT_SECS: u64 = 8;
const SSH_TIMEOUT_MS: u32 = 15_000;
const EXEC_TIMEOUT_MS: u32 = 30_000;

fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let addr = format!("{}:{}", host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Resolve {}:{}: {}", host, port, e))?
        .next()
        .ok_or_else(|| format!("No address for {}:{}", host, port))?;
    TcpStream::connect_timeout(&addr, Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .map_err(|e| format!("TCP connect {}:{}: {}", host, port, e))
}

fn known_hosts_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "No HOME".to_string())?;
    let dir = std::path::Path::new(&home).join(".weterm");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .weterm: {}", e))?;
    Ok(dir.join("known_hosts"))
}

pub fn clear_known_hosts() -> Result<(), String> {
    let path = known_hosts_path()?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove known_hosts: {}", e))?;
    }
    Ok(())
}

/// Trust-on-first-use host key check. New hosts are recorded in ~/.weterm/known_hosts;
/// changed keys are rejected to reduce MITM risk.
fn verify_host_key(session: &Session, host: &str, port: u16) -> Result<(), String> {
    let mut kh = session
        .known_hosts()
        .map_err(|e| format!("known_hosts: {}", e))?;
    let path = known_hosts_path()?;
    if path.exists() {
        let _ = kh.read_file(&path, KnownHostFileKind::OpenSSH);
    }
    let (key, key_type) = session
        .host_key()
        .ok_or("No host key received".to_string())?;
    let key_fmt: KnownHostKeyFormat = key_type.into();
    match kh.check_port(host, port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::Mismatch => Err(format!(
            "Host key for {}:{} has changed; possible security issue",
            host, port
        )),
        CheckResult::Failure => Err("Host key verification failed".to_string()),
        CheckResult::NotFound => {
            let entry = format!("[{}]:{}", host, port);
            kh.add(&entry, key, "weterm", key_fmt)
                .map_err(|e| format!("add known host: {}", e))?;
            kh.write_file(&path, KnownHostFileKind::OpenSSH)
                .map_err(|e| format!("save known_hosts: {}", e))?;
            Ok(())
        }
    }
}

pub struct ManagedConnection {
    pub session: Session,
    pub channel: Option<Channel>,
    pub cwd: String,
}

unsafe impl Send for ManagedConnection {}

impl ManagedConnection {
    pub fn start_shell(&mut self) -> Result<(), String> {
        let mut ch = self
            .session
            .channel_session()
            .map_err(|e| format!("Channel: {}", e))?;
        let (w, h) = (80, 24);
        ch.request_pty("xterm-256color", None, Some((w, h, 0, 0)))
            .map_err(|e| format!("PTY: {}", e))?;
        ch.shell().map_err(|e| format!("Shell: {}", e))?;
        self.channel = Some(ch);
        Ok(())
    }

    pub fn shell_write(&mut self, data: &str) -> Result<(), String> {
        self.channel
            .as_mut()
            .ok_or("No shell")?
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write: {}", e))
    }

    pub fn resize_pty(&mut self, cols: u32, rows: u32) -> Result<(), String> {
        self.channel
            .as_mut()
            .ok_or("No shell")?
            .request_pty_size(cols, rows, None, None)
            .map_err(|e| format!("Resize: {}", e))
    }

    pub fn shell_read(&mut self) -> Result<String, String> {
        let ch = self.channel.as_mut().ok_or("No shell")?;
        let _ = self.session.set_blocking(false);
        let mut buf = [0u8; 8192];
        let mut out = String::new();
        loop {
            match ch.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
        let _ = self.session.set_blocking(true);
        Ok(out)
    }

    pub fn execute(&mut self, cmd: &str) -> Result<String, String> {
        if cmd.starts_with("cd ") {
            let dir = cmd[3..].trim();
            let r = self.run_cmd(&format!("cd {} && pwd", dir))?;
            self.cwd = r.trim().to_string();
            return Ok(String::new());
        }
        self.run_cmd(&format!("cd {} && {}", self.cwd, cmd))
    }

    fn run_cmd(&self, cmd: &str) -> Result<String, String> {
        let _ = self.session.set_timeout(EXEC_TIMEOUT_MS);
        let mut ch = self.session.channel_session().map_err(|e| e.to_string())?;
        ch.exec(cmd).map_err(|e| e.to_string())?;
        let mut out = String::new();
        ch.read_to_string(&mut out).map_err(|e| e.to_string())?;
        ch.wait_close().map_err(|e| e.to_string())?;
        Ok(out)
    }

    pub fn close_shell(&mut self) {
        self.channel.take();
    }
}

pub struct SshManager {
    connections: HashMap<String, ManagedConnection>,
}

/// Dedicated SSH session purely for SFTP transfers — owns its own TCP connection.
/// Because the main session is used for terminal I/O, transfers on a separate
/// connection never block typing or terminal output.
pub struct SftpSession {
    session: Session,
}

unsafe impl Send for SftpSession {}
unsafe impl Sync for SftpSession {}

impl SftpSession {
    pub fn connect(
        host: &str,
        port: u16,
        username: &str,
        password: Option<&str>,
        key_path: Option<&str>,
    ) -> Result<Self, String> {
        let tcp = connect_tcp(host, port).map_err(|e| format!("SFTP {}", e))?;
        let mut session = Session::new().map_err(|e| e.to_string())?;
        session.set_tcp_stream(tcp);
        session.set_timeout(SSH_TIMEOUT_MS);
        session
            .handshake()
            .map_err(|e| format!("SFTP handshake: {}", e))?;
        verify_host_key(&session, host, port)?;
        if let Some(p) = password {
            session
                .userauth_password(username, p)
                .map_err(|e| format!("SFTP auth: {}", e))?;
        } else if let Some(k) = key_path {
            session
                .userauth_pubkey_file(username, None, Path::new(k), password)
                .map_err(|e| format!("SFTP key: {}", e))?;
        } else {
            session
                .userauth_agent(username)
                .map_err(|e| format!("SFTP agent: {}", e))?;
        }
        if !session.authenticated() {
            return Err("SFTP auth failed".into());
        }
        Ok(SftpSession { session })
    }

    pub fn sftp(&self) -> Result<Sftp, String> {
        self.session.sftp().map_err(|e| format!("SFTP: {}", e))
    }
}

/// Manages dedicated SFTP sessions, keyed by connection id.
/// Uses its own Mutex so transfers never contend with terminal operations.
pub struct TransferManager {
    sessions: HashMap<String, Arc<SftpSession>>,
}

impl TransferManager {
    pub fn new() -> Self {
        TransferManager {
            sessions: HashMap::new(),
        }
    }

    pub fn add(&mut self, id: &str, session: SftpSession) {
        self.sessions.insert(id.into(), Arc::new(session));
    }

    pub fn remove(&mut self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn get(&self, id: &str) -> Result<Arc<SftpSession>, String> {
        self.sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "No SFTP session".to_string())
    }

    /// Simple download without progress events — used for drag-out to Finder.
    pub fn download_file_only(
        sess: &SftpSession,
        remote: &str,
        local: &str,
    ) -> Result<u64, String> {
        let sftp = sess.sftp()?;
        let mut rf = sftp.open(Path::new(remote)).map_err(|e| e.to_string())?;
        let mut lf = std::fs::File::create(Path::new(local)).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 262144];
        let mut written = 0u64;
        loop {
            let n = rf.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            lf.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            written += n as u64;
        }
        Ok(written)
    }

    /// Transfer function — session is passed in, no lock held during I/O.
    /// Progress is throttled to ~4 emits/sec (250ms interval) to avoid overwhelming
    /// the Tauri IPC event system and the React frontend.
    pub fn download(
        sess: &SftpSession,
        remote: &str,
        local: &str,
        transfer_id: &str,
        app: &AppHandle,
        cancel: &Arc<AtomicBool>,
    ) -> Result<u64, String> {
        let sftp = sess.sftp()?;
        let stat = sftp
            .stat(Path::new(remote))
            .map_err(|e| format!("Stat: {}", e))?;
        let total = stat.size.unwrap_or(0);
        let mut rf = sftp.open(Path::new(remote)).map_err(|e| e.to_string())?;
        let mut lf = std::fs::File::create(Path::new(local)).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 262144]; // 256 KB — fewer I/O calls, fewer progress events
        let mut written = 0u64;
        let start = Instant::now();
        let mut last_emit = Instant::now();
        let emit_interval = std::time::Duration::from_millis(250);
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(lf);
                let _ = std::fs::remove_file(Path::new(local));
                return Err("Cancelled".into());
            }
            let n = rf.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            lf.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            written += n as u64;
            // Throttle: only emit progress every 250ms
            let now = Instant::now();
            if now - last_emit >= emit_interval {
                let elapsed = start.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 {
                    written as f64 / elapsed
                } else {
                    0.0
                };
                let eta = if speed > 0.0 && total > 0 {
                    ((total - written) as f64 / speed) as u64
                } else {
                    0
                };
                let _ = app.emit(
                    "transfer-progress",
                    serde_json::json!({
                        "id": transfer_id, "written": written, "total": total,
                        "speed": speed as u64, "eta": eta,
                    }),
                );
                last_emit = now;
            }
        }
        // Always emit final progress
        let elapsed = start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            written as f64 / elapsed
        } else {
            0.0
        };
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "id": transfer_id, "written": written, "total": total,
                "speed": speed as u64, "eta": 0u64,
            }),
        );
        Ok(written)
    }

    pub fn upload(
        sess: &SftpSession,
        local: &str,
        remote: &str,
        transfer_id: &str,
        app: &AppHandle,
        cancel: &Arc<AtomicBool>,
    ) -> Result<u64, String> {
        let sftp = sess.sftp()?;
        let total = std::fs::metadata(Path::new(local))
            .map_err(|e| e.to_string())?
            .len();
        let mut lf = std::fs::File::open(Path::new(local)).map_err(|e| e.to_string())?;
        let mut rf = sftp.create(Path::new(remote)).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 262144]; // 256 KB
        let mut written = 0u64;
        let start = Instant::now();
        let mut last_emit = Instant::now();
        let emit_interval = std::time::Duration::from_millis(250);
        loop {
            if cancel.load(Ordering::Relaxed) {
                drop(rf);
                let _ = sess
                    .sftp()
                    .ok()
                    .and_then(|s| super::sftp_manager::do_delete(&s, remote).ok());
                return Err("Cancelled".into());
            }
            let n = lf.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            rf.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            written += n as u64;
            let now = Instant::now();
            if now - last_emit >= emit_interval {
                let elapsed = start.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 {
                    written as f64 / elapsed
                } else {
                    0.0
                };
                let eta = if speed > 0.0 && total > 0 {
                    ((total - written) as f64 / speed) as u64
                } else {
                    0
                };
                let _ = app.emit(
                    "transfer-progress",
                    serde_json::json!({
                        "id": transfer_id, "written": written, "total": total,
                        "speed": speed as u64, "eta": eta,
                    }),
                );
                last_emit = now;
            }
        }
        // Always emit final progress
        let elapsed = start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            written as f64 / elapsed
        } else {
            0.0
        };
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "id": transfer_id, "written": written, "total": total,
                "speed": speed as u64, "eta": 0u64,
            }),
        );
        Ok(written)
    }

    /// Download a directory recursively with progress
    pub fn download_dir(
        sess: &SftpSession,
        remote_dir: &str,
        local_dir: &str,
        transfer_id: &str,
        app: &AppHandle,
        cancel: &Arc<AtomicBool>,
    ) -> Result<u64, String> {
        // Send initial progress so UI doesn't look frozen during listing
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "id": transfer_id, "written": 0u64, "total": 0u64,
                "speed": 0u64, "eta": 0u64,
            }),
        );
        let sftp = sess.sftp()?;
        let files = super::sftp_manager::do_list_files_recursive(&sftp, remote_dir)?;
        let total: u64 = files
            .iter()
            .filter(|f| !f.is_dir)
            .map(|f| f.size as u64)
            .sum();
        let mut written = 0u64;
        let start = Instant::now();
        let mut last_emit;
        let emit_interval = std::time::Duration::from_millis(250);

        // Create local root dir
        std::fs::create_dir_all(local_dir).map_err(|e| e.to_string())?;

        // Emit progress again now that we know total size
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "id": transfer_id, "written": 0u64, "total": total,
                "speed": 0u64, "eta": 0u64,
            }),
        );
        last_emit = Instant::now();

        for f in &files {
            if cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
            if f.is_dir {
                continue;
            }
            // Determine relative path
            let rel = f
                .path
                .strip_prefix(remote_dir)
                .unwrap_or(&f.path)
                .trim_start_matches('/');
            let local_path = Path::new(local_dir).join(rel);
            if let Some(parent) = local_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            super::sftp_manager::do_download(&sftp, &f.path, local_path.to_str().unwrap_or(""))?;
            written += f.size as u64;
            let now = Instant::now();
            if now - last_emit >= emit_interval {
                let elapsed = start.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 {
                    written as f64 / elapsed
                } else {
                    0.0
                };
                let eta = if speed > 0.0 && total > 0 {
                    ((total - written) as f64 / speed) as u64
                } else {
                    0
                };
                let _ = app.emit(
                    "transfer-progress",
                    serde_json::json!({
                        "id": transfer_id, "written": written, "total": total,
                        "speed": speed as u64, "eta": eta,
                    }),
                );
                last_emit = now;
            }
        }
        // Final progress emit
        let elapsed = start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            written as f64 / elapsed
        } else {
            0.0
        };
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "id": transfer_id, "written": written, "total": total,
                "speed": speed as u64, "eta": 0u64,
            }),
        );
        Ok(written)
    }

    /// Upload a directory recursively with progress
    pub fn upload_dir(
        sess: &SftpSession,
        local_dir: &str,
        remote_dir: &str,
        transfer_id: &str,
        app: &AppHandle,
        cancel: &Arc<AtomicBool>,
    ) -> Result<u64, String> {
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "id": transfer_id, "written": 0u64, "total": 0u64,
                "speed": 0u64, "eta": 0u64,
            }),
        );
        let sftp = sess.sftp()?;
        // For upload we need local file listing
        let local_files = Self::list_local_recursive(local_dir)?;
        let total: u64 = local_files
            .iter()
            .filter(|f| !f.is_dir)
            .map(|f| f.size as u64)
            .sum();
        let mut written = 0u64;
        let start = Instant::now();
        let mut last_emit;
        let emit_interval = std::time::Duration::from_millis(250);

        sftp.mkdir(Path::new(remote_dir), 0o755)
            .map_err(|e| e.to_string())?;

        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "id": transfer_id, "written": 0u64, "total": total,
                "speed": 0u64, "eta": 0u64,
            }),
        );
        last_emit = Instant::now();

        for f in &local_files {
            if cancel.load(Ordering::Relaxed) {
                return Err("Cancelled".into());
            }
            if f.is_dir {
                let rel = f
                    .path
                    .strip_prefix(local_dir)
                    .unwrap_or(&f.path)
                    .trim_start_matches('/');
                let rp = format!("{}/{}", remote_dir.trim_end_matches('/'), rel);
                let _ = sftp.mkdir(Path::new(&rp), 0o755);
                continue;
            }
            let rel = f
                .path
                .strip_prefix(local_dir)
                .unwrap_or(&f.path)
                .trim_start_matches('/');
            let rp = format!("{}/{}", remote_dir.trim_end_matches('/'), rel);
            // Ensure remote parent dirs exist
            if let Some(parent) = Path::new(&rp).parent().and_then(|p| p.to_str()) {
                let _ = sftp.mkdir(Path::new(parent), 0o755);
            }
            super::sftp_manager::do_upload(&sftp, &f.path, &rp)?;
            written += f.size as u64;
            let now = Instant::now();
            if now - last_emit >= emit_interval {
                let elapsed = start.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 {
                    written as f64 / elapsed
                } else {
                    0.0
                };
                let eta = if speed > 0.0 && total > 0 {
                    ((total - written) as f64 / speed) as u64
                } else {
                    0
                };
                let _ = app.emit(
                    "transfer-progress",
                    serde_json::json!({
                        "id": transfer_id, "written": written, "total": total,
                        "speed": speed as u64, "eta": eta,
                    }),
                );
                last_emit = now;
            }
        }
        // Final progress emit
        let elapsed = start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            written as f64 / elapsed
        } else {
            0.0
        };
        let _ = app.emit(
            "transfer-progress",
            serde_json::json!({
                "id": transfer_id, "written": written, "total": total,
                "speed": speed as u64, "eta": 0u64,
            }),
        );
        Ok(written)
    }

    fn list_local_recursive(dir: &str) -> Result<Vec<super::sftp_manager::FileEntry>, String> {
        let mut result = Vec::new();
        let d = Path::new(dir);
        if !d.is_dir() {
            return Err(format!("Not a dir: {}", dir));
        }
        for entry in std::fs::read_dir(d).map_err(|e| e.to_string())? {
            let e = entry.map_err(|e| e.to_string())?;
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path().to_string_lossy().to_string();
            let meta = e.metadata().map_err(|e| e.to_string())?;
            let fe = super::sftp_manager::FileEntry {
                name,
                path: path.clone(),
                is_dir: meta.is_dir(),
                size: meta.len() as i64,
                permissions: String::new(),
                modified: String::new(),
                owner: String::new(),
                group: String::new(),
            };
            if fe.is_dir {
                result.push(fe);
                if let Ok(children) = Self::list_local_recursive(&path) {
                    result.extend(children);
                }
            } else {
                result.push(fe);
            }
        }
        // Sort: dirs first, then files
        result.sort_by(|a, b| {
            if a.is_dir != b.is_dir {
                b.is_dir.cmp(&a.is_dir)
            } else {
                a.name.cmp(&b.name)
            }
        });
        Ok(result)
    }
}

impl SshManager {
    pub fn new() -> Self {
        SshManager {
            connections: HashMap::new(),
        }
    }

    pub fn connect(
        &mut self,
        id: &str,
        host: &str,
        port: u16,
        username: &str,
        password: Option<&str>,
        key_path: Option<&str>,
    ) -> Result<String, String> {
        let tcp = connect_tcp(host, port)?;
        let mut session = Session::new().map_err(|e| e.to_string())?;
        session.set_tcp_stream(tcp);
        session.set_timeout(SSH_TIMEOUT_MS);
        session
            .handshake()
            .map_err(|e| format!("Handshake: {}", e))?;
        verify_host_key(&session, host, port)?;
        if let Some(p) = password {
            session
                .userauth_password(username, p)
                .map_err(|e| format!("Auth: {}", e))?;
        } else if let Some(k) = key_path {
            session
                .userauth_pubkey_file(username, None, Path::new(k), password)
                .map_err(|e| format!("Key: {}", e))?;
        } else {
            session
                .userauth_agent(username)
                .map_err(|e| format!("Agent: {}", e))?;
        }
        if !session.authenticated() {
            return Err("Auth failed".into());
        }
        let home = Self::detect_home(&session);
        let mut conn = ManagedConnection {
            session,
            channel: None,
            cwd: home.clone(),
        };
        conn.start_shell()?;
        self.connections.insert(id.into(), conn);
        Ok(home)
    }

    fn detect_home(session: &Session) -> String {
        if let Ok(mut ch) = session.channel_session() {
            if ch.exec("echo ~").is_ok() {
                let mut o = String::new();
                let _ = ch.read_to_string(&mut o);
                let _ = ch.wait_close();
                return o.trim().into();
            }
        }
        "/".into()
    }

    pub fn disconnect(&mut self, id: &str) -> Result<(), String> {
        if let Some(mut c) = self.connections.remove(id) {
            c.close_shell();
        }
        Ok(())
    }

    pub fn execute(&mut self, id: &str, cmd: &str) -> Result<String, String> {
        self.connections
            .get_mut(id)
            .ok_or_else(|| "No conn".to_string())?
            .execute(cmd)
    }

    pub fn shell_write(&mut self, id: &str, data: &str) -> Result<(), String> {
        let c = self
            .connections
            .get_mut(id)
            .ok_or_else(|| "No conn".to_string())?;
        c.shell_write(data)
    }

    pub fn shell_resize(&mut self, id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let c = self
            .connections
            .get_mut(id)
            .ok_or_else(|| "No conn".to_string())?;
        c.resize_pty(cols, rows)
    }

    pub fn shell_read(&mut self, id: &str) -> Result<String, String> {
        self.connections
            .get_mut(id)
            .ok_or_else(|| "No conn".to_string())?
            .shell_read()
    }
}
