use serde::Serialize;
use ssh2::Sftp;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: i64,
    pub permissions: String,
    pub modified: String,
    pub owner: String,
    pub group: String,
}

fn fmt_perm(perm: u32) -> String {
    let perm = perm as i32;
    let mut s = String::with_capacity(10);
    let t = if perm & 0o40000 != 0 { 'd' } else { '-' };
    s.push(t);
    s.push(if perm & 0o400 != 0 { 'r' } else { '-' });
    s.push(if perm & 0o200 != 0 { 'w' } else { '-' });
    s.push(if perm & 0o100 != 0 { 'x' } else { '-' });
    s.push(if perm & 0o040 != 0 { 'r' } else { '-' });
    s.push(if perm & 0o020 != 0 { 'w' } else { '-' });
    s.push(if perm & 0o010 != 0 { 'x' } else { '-' });
    s.push(if perm & 0o004 != 0 { 'r' } else { '-' });
    s.push(if perm & 0o002 != 0 { 'w' } else { '-' });
    s.push(if perm & 0o001 != 0 { 'x' } else { '-' });
    s
}

fn fmt_time(secs: u64) -> String {
    let d = UNIX_EPOCH + std::time::Duration::from_secs(secs);
    let since: std::time::Duration = d.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs_total = since.as_secs();
    // Simple YYYY-MM-DD HH:MM format
    let days = secs_total / 86400;
    // Approximate: works for dates after 1970
    let mut y = 1970i64;
    let mut remaining = days as i64;
    loop {
        let year_days = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
            366
        } else {
            365
        };
        if remaining < year_days {
            break;
        }
        remaining -= year_days;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days: [i64; 12] = [
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
    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if remaining < md {
            m = i + 1;
            break;
        }
        remaining -= md;
    }
    let day = remaining + 1;
    let hour = (secs_total / 3600) % 24;
    let min = (secs_total / 60) % 60;
    format!("{:04}-{:02}-{:02} {:02}:{:02}", y, m, day, hour, min)
}

pub fn do_list_files(sftp: &Sftp, path: &str) -> Result<Vec<FileEntry>, String> {
    let entries = sftp
        .readdir(Path::new(path))
        .map_err(|e| format!("Failed to list directory: {}", e))?;

    let mut files: Vec<FileEntry> = entries
        .into_iter()
        .map(|(entry_path, stat)| {
            let name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let perm = stat.perm.unwrap_or(0);
            let modified = stat.mtime.map(fmt_time).unwrap_or_else(|| "--".into());
            let owner = stat
                .uid
                .map(|u| u.to_string())
                .unwrap_or_else(|| "--".into());
            let group = stat
                .gid
                .map(|g| g.to_string())
                .unwrap_or_else(|| "--".into());

            FileEntry {
                name,
                path: entry_path.to_string_lossy().to_string(),
                is_dir: stat.is_dir(),
                size: stat.size.unwrap_or(0) as i64,
                permissions: fmt_perm(perm),
                modified,
                owner,
                group,
            }
        })
        .collect();

    // Sort: dirs first, then files; hidden files (starting with .) after normal files; alphabetical within each group
    files.sort_by(|a, b| {
        let a_hidden = a.name.starts_with('.');
        let b_hidden = b.name.starts_with('.');
        if a.is_dir != b.is_dir {
            return b.is_dir.cmp(&a.is_dir);
        }
        if a_hidden != b_hidden {
            return a_hidden.cmp(&b_hidden);
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(files)
}

pub fn do_list_files_recursive(sftp: &Sftp, path: &str) -> Result<Vec<FileEntry>, String> {
    let mut result = Vec::new();
    let entries = sftp
        .readdir(Path::new(path))
        .map_err(|e| format!("Failed to list directory: {}", e))?;
    for (entry_path, stat) in entries {
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if name == "." || name == ".." {
            continue;
        }
        let perm = stat.perm.unwrap_or(0);
        let modified = stat.mtime.map(fmt_time).unwrap_or_else(|| "--".into());
        let owner = stat
            .uid
            .map(|u| u.to_string())
            .unwrap_or_else(|| "--".into());
        let group = stat
            .gid
            .map(|g| g.to_string())
            .unwrap_or_else(|| "--".into());
        let fe = FileEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir: stat.is_dir(),
            size: stat.size.unwrap_or(0) as i64,
            permissions: fmt_perm(perm),
            modified,
            owner,
            group,
        };
        if fe.is_dir {
            if let Ok(children) = do_list_files_recursive(sftp, &fe.path) {
                result.push(fe);
                result.extend(children);
            }
        } else {
            result.push(fe);
        }
    }
    Ok(result)
}

pub fn do_download(sftp: &Sftp, remote_path: &str, local_path: &str) -> Result<(), String> {
    let mut remote_file = sftp
        .open(Path::new(remote_path))
        .map_err(|e| format!("Failed to open remote file: {}", e))?;

    let mut local_file = std::fs::File::create(Path::new(local_path))
        .map_err(|e| format!("Failed to create local file: {}", e))?;

    let mut buf = [0u8; 65536];
    loop {
        let n = remote_file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read remote file: {}", e))?;
        if n == 0 {
            break;
        }
        local_file
            .write_all(&buf[..n])
            .map_err(|e| format!("Failed to write local file: {}", e))?;
    }
    Ok(())
}

pub fn do_upload(sftp: &Sftp, local_path: &str, remote_path: &str) -> Result<(), String> {
    let mut local_file = std::fs::File::open(Path::new(local_path))
        .map_err(|e| format!("Failed to open local file: {}", e))?;

    let mut remote_file = sftp
        .create(Path::new(remote_path))
        .map_err(|e| format!("Failed to create remote file: {}", e))?;

    let mut buf = [0u8; 65536];
    loop {
        let n = local_file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read local file: {}", e))?;
        if n == 0 {
            break;
        }
        remote_file
            .write_all(&buf[..n])
            .map_err(|e| format!("Failed to write remote file: {}", e))?;
    }
    Ok(())
}

pub fn do_delete(sftp: &Sftp, path: &str) -> Result<(), String> {
    let p = Path::new(path);
    let stat = sftp
        .stat(p)
        .map_err(|e| format!("Failed to stat for delete: {}", e))?;
    if stat.is_dir() {
        do_delete_dir(sftp, path)?;
    } else {
        sftp.unlink(p)
            .map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    Ok(())
}

/// Recursively delete a directory and all its contents via SFTP.
fn do_delete_dir(sftp: &Sftp, path: &str) -> Result<(), String> {
    let entries = sftp
        .readdir(Path::new(path))
        .map_err(|e| format!("Failed to list dir for deletion: {}", e))?;
    for (entry_path, stat) in entries {
        let name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if name == "." || name == ".." {
            continue;
        }
        let full = entry_path.to_string_lossy().to_string();
        if stat.is_dir() {
            do_delete_dir(sftp, &full)?;
        } else {
            sftp.unlink(&entry_path)
                .map_err(|e| format!("Failed to unlink '{}': {}", full, e))?;
        }
    }
    sftp.rmdir(Path::new(path))
        .map_err(|e| format!("Failed to remove directory '{}': {}", path, e))?;
    Ok(())
}

pub fn do_create_dir(sftp: &Sftp, path: &str) -> Result<(), String> {
    let p = Path::new(path);
    // Stat first — if it already exists at any level, skip that level
    if sftp.stat(p).is_ok() {
        return Ok(());
    }
    // Recursively create parent directories
    if let Some(parent) = p.parent() {
        let parent_str = parent.to_string_lossy().to_string();
        if !parent_str.is_empty() && parent_str != "/" && parent_str != "." {
            if sftp.stat(parent).is_err() {
                do_create_dir(sftp, &parent_str)?;
            }
        }
    }
    sftp.mkdir(p, 0o755)
        .map_err(|e| format!("Failed to create directory '{}': {}", path, e))
}

pub fn do_rename(sftp: &Sftp, old_path: &str, new_path: &str) -> Result<(), String> {
    // Try rename with OVERWRITE flag first (libssh2 >= 1.9.0),
    // fall back to simple rename without flags for compatibility.
    use ssh2::RenameFlags;
    let result = sftp.rename(
        Path::new(old_path),
        Path::new(new_path),
        Some(RenameFlags::OVERWRITE),
    );
    if result.is_err() {
        // Fallback: try without flags (older SFTP servers / libssh2 versions)
        sftp.rename(Path::new(old_path), Path::new(new_path), None)
            .map_err(|e| format!("Failed to rename: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_permissions() {
        assert_eq!(fmt_perm(0o40755), "drwxr-xr-x");
        assert_eq!(fmt_perm(0o100644), "-rw-r--r--");
        assert_eq!(fmt_perm(0o100755), "-rwxr-xr-x");
    }

    #[test]
    fn formats_mtime() {
        // 2025-07-30 12:00:00 UTC
        assert_eq!(fmt_time(1_753_876_800), "2025-07-30 12:00");
    }
}
