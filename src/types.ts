export interface SessionConfig {
  id: string; name: string; host: string; port: number;
  username: string; authType: "password" | "key" | "agent";
  password?: string; keyPath?: string;
}

export interface SavedConnection {
  name: string; host: string; port: number;
  username: string; authType: string;
  keyPath?: string;
  hasKeychainSecret?: boolean;
}

export interface FileEntry {
  name: string; path: string; is_dir: boolean; size: number;
  permissions: string; modified: string;
  owner: string; group: string;
}

export type ActivityType = "command" | "download" | "upload";

export interface ActivityEntry {
  id: string;
  type: ActivityType;
  timestamp: number;
  detail: string;
}

export interface AppSettings {
  showCommandsTab: boolean;
  showTasksTab: boolean;
  maxSavedEntries: number;
  maxDisplayEntries: number;
  showCpu: boolean;
  showMem: boolean;
  showLoginTime: boolean;
  showDuration: boolean;
  statusStyle: "text" | "circles";
  theme: string; // "dark" | "light" | "system" | "custom"
  customColors?: string; // JSON string of CSS variable overrides
  fontFamily: string;          // shared font family for UI, terminal & notepad
  uiFontFamily: string;        // UI text font family
  terminalFontFamily: string;  // terminal & monospace font family
  notepadFontFamily: string;   // notepad font family
  terminalFontSize: number;
  uiFontSize: number;
  notepadFontSize: number;
  showFileMeta: boolean;
  showFilePermissions: boolean;
  showFileOwner: boolean;
  showFileModified: boolean;
  showFileSize: boolean;
  showNotepadTab: boolean;
  notepadSavePath: string;
  activitySavePath: string;
  showMonitorTab: boolean;
  terminalBgColor: string;
  terminalFgColor: string;
}

// ── System monitoring data ──

export interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memPercent: number;
}

export interface MonitorData {
  cpuPercent: number;
  memUsedGb: number;
  memTotalGb: number;
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  topProcesses: ProcessInfo[];
}

/** Mirror of Rust's ActivityEntryData for per-host history persistence */
export interface ActivityEntryData {
  id: string;
  type: ActivityType;
  timestamp: number;
  detail: string;
}

/** Custom user-defined command */
export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

/** Notepad file info from Rust */
export interface NotepadFileInfo {
  name: string;
  size: number;
  modified: string;
}
