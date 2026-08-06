import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo, startTransition } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type { SessionConfig, SavedConnection, FileEntry } from "./types";
import TopBar from "./components/TopBar";
import FileBrowser from "./components/FileBrowser";
import SshTerminal from "./components/SshTerminal";
import type { SshTerminalHandle } from "./components/SshTerminal";
import FileEditor from "./components/FileEditor";
import BottomBar from "./components/BottomBar";
import ResizeHandle from "./components/ResizeHandle";
import ActivityLog from "./components/ActivityLog";
import TaskPanel from "./components/TaskPanel";
// import MonitorPanel from "./components/MonitorPanel"; // temporarily disabled (perf)
import SettingsModal from "./components/SettingsModal";
import type { ActivityEntry, ActivityEntryData, AppSettings, CustomCommand } from "./types";
import ConnectionPickerModal from "./components/ConnectionPickerModal";
import ConfirmReplaceModal from "./components/ConfirmReplaceModal";
import NamePromptModal from "./components/NamePromptModal";
import Notepad from "./components/Notepad";
import ToastHost from "./components/ToastHost";
import { progressStore, type ProgressData } from "./progressStore";
import { showToast } from "./toastStore";
import "./App.css";

const RecapPanel = lazy(() => import("./components/RecapPanel"));

export interface TransferItem {
  id: string; name: string; direction: "upload" | "download";
  written: number; total: number; speed: number; eta: number;
  status: "waiting" | "transferring" | "done" | "error" | "cancelled";
  srcPath?: string; dstPath?: string;
  crossDir?: "to-top" | "to-bottom"; // cross-server transfer direction
  sessionId?: string; // which session this transfer belongs to
}

export interface StatusInfo {
  cpuPercent: string; memUsedGb: string; memTotalGb: string;
  loginTime: number; connectedSince: number;
}

interface TransferCompleteEvent {
  id: string; success: boolean; error: string;
}

export default function App() {
  const [sessions, setSessions] = useState<Map<string, SessionConfig>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [localPath, setLocalPath] = useState("~/Desktop");
  const [history, setHistory] = useState<SavedConnection[]>([]);
  const [editor, setEditor] = useState<{ sessionId: string; path: string; name: string } | null>(null);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [dragOver, setDragOver] = useState<"top" | "bottom" | null>(null);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const [termDragOver, setTermDragOver] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  /// Prefill connection form from history click (avoids window.prompt in webview)
  const [prefillConn, setPrefillConn] = useState<SavedConnection | null>(null);
  const [namePrompt, setNamePrompt] = useState<{
    title: string;
    label: string;
    initialValue: string;
    onSubmit: (value: string) => Promise<void>;
  } | null>(null);
  const dragClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /// WKWebView restricts getData() in drop events — capture payload during dragover
  const dragDataRef = useRef<string | null>(null);

  // ── Recap recording state ──
  interface RecapEvent { t: number; d: string; type: "output" | "input"; }
  const [recording, setRecording] = useState<{ sessionId: string; sessionName: string; startedAt: number; events: RecapEvent[] } | null>(null);
  const [showRecap, setShowRecap] = useState(false);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  // ── Custom commands ──
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);

  // ── Notepad height ──
  const [notepadHeight, setNotepadHeight] = useState<number | null>(null);
  // const [monitorHeight, setMonitorHeight] = useState<number | null>(null); // disabled (perf)

  // ── Resizable panel state ──
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [remoteHeight, setRemoteHeight] = useState<number | null>(null);
  const [activityLogWidth, setActivityLogWidth] = useState(260);
  const [commandLogHeight, setCommandLogHeight] = useState<number | null>(200);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);

  // ── Per-session state ──
  interface SessionState {
    remotePath: string;
    activity: ActivityEntry[];
    loginTime: number;
    connectedSince: number;
    hostKey: string;
    remoteCpu: string;        // remote server CPU%, "--" until first poll
    remoteMemGb: string;      // remote server used mem GB
    remoteMemTotalGb: string; // remote server total mem GB
  }
  const [sessionStates, setSessionStates] = useState<Record<string, SessionState>>({});
  const sessionRef = useRef(sessionStates);
  sessionRef.current = sessionStates;

  // System-wide CPU/memory (updated by polling, not per-session)
  const [cpuPercent, setCpuPercent] = useState("--");
  const [memUsedGb, setMemUsedGb] = useState("--");
  const [memTotalGb, setMemTotalGb] = useState("--");

  // Derived from active session
  const activeSession = activeId ? sessions.get(activeId) : null;
  const activeState = activeId ? sessionStates[activeId] : null;
  const remotePath = activeState?.remotePath ?? "/";
  const activityEntries = activeState?.activity ?? [];
  const hostKeyRef = useRef<string | null>(null);
  hostKeyRef.current = activeState?.hostKey ?? null;

  const statusInfo: StatusInfo = {
    cpuPercent: activeState?.remoteCpu && activeState.remoteCpu !== "--"
      ? activeState.remoteCpu : cpuPercent,
    memUsedGb: activeState?.remoteMemGb && activeState.remoteMemGb !== "--"
      ? activeState.remoteMemGb : memUsedGb,
    memTotalGb: activeState?.remoteMemTotalGb && activeState.remoteMemTotalGb !== "--"
      ? activeState.remoteMemTotalGb : memTotalGb,
    loginTime: activeState?.loginTime ?? 0,
    connectedSince: activeState?.connectedSince ?? 0,
  };

  // Tab numbering counter
  const tabCounterRef = useRef(0);
  const [tabNumbers, setTabNumbers] = useState<Record<string, number>>({});

  // ── Settings ──
  const DEFAULT_SETTINGS: AppSettings = {
    showCommandsTab: true, showTasksTab: true,
    maxSavedEntries: 10000, maxDisplayEntries: 50,
    showCpu: true, showMem: true, showLoginTime: true, showDuration: true,
    statusStyle: "text",
    theme: "dark",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
    uiFontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
    terminalFontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    notepadFontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    terminalFontSize: 13, uiFontSize: 13, notepadFontSize: 11,
    showFileMeta: true,
    showFilePermissions: true, showFileOwner: true,
    showFileModified: true, showFileSize: true,
    showNotepadTab: true, notepadSavePath: "~/.weterm/notepad",
    activitySavePath: "~/.weterm/activity",
    showMonitorTab: false, terminalBgColor: "#000000", terminalFgColor: "#f5f5f7", // Monitor temporarily disabled
  };
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Collect transfer history for active session only (for TaskPanel history)
  const activeTransferHistory = useMemo(() => {
    if (!activeId) return [] as ActivityEntry[];
    const s = sessionStates[activeId];
    if (!s) return [] as ActivityEntry[];
    return s.activity
      .filter(e => e.type === "upload" || e.type === "download")
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, settings.maxDisplayEntries);
  }, [sessionStates, activeId, settings.maxDisplayEntries]);

  // Filter active transfers to current session
  const sessionTransfers = useMemo(() =>
    transfers.filter(t => !t.sessionId || t.sessionId === activeId),
    [transfers, activeId]
  );

  // Terminal ref for pasting text from activity log
  const terminalRef = useRef<SshTerminalHandle>(null);

  // Remote clipboard for copy/paste
  const [remoteClipboard, setRemoteClipboard] = useState<{ path: string; name: string } | null>(null);

  // ── Bottom panel (independent connection) ──
  type BottomConn = { type: "local" } | { type: "remote"; sessionId: string };
  const [bottomConn, setBottomConn] = useState<BottomConn>({ type: "local" });
  const [bottomLocalPath, setBottomLocalPath] = useState("~/Desktop");
  // Remote path for bottom panel (when connected to a server)
  const bottomRemotePath = bottomConn.type === "remote"
    ? (sessionStates[bottomConn.sessionId]?.remotePath ?? "/")
    : "";

  // ── Connection picker ──
  const [pickerPanel, setPickerPanel] = useState<"top" | "bottom" | null>(null);

  // Pending cross-server transfers: dl_tid -> { upload info }
  const crossRef = useRef<Record<string, { targetSessionId: string; tmpPath: string; remoteDest: string; name: string; crossName: string; crossDir: "to-top" | "to-bottom"; isDir?: boolean }>>({});

  // Track upload transfer IDs -> temp file paths for cleanup on completion
  const uploadTempRef = useRef<Record<string, string>>({});
  // Throttle transfer progress to avoid UI stutter during high-speed transfers
  const tpBufferRef = useRef<Record<string, Partial<TransferItem>>>({});
  const tpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── File conflict dialog ──
  interface ConflictState { fileName: string; copyName: string; onReplace: () => void; onRename: () => void; onCancel: () => void; }
  const [conflict, setConflict] = useState<ConflictState | null>(null);

  // Save activity history whenever entries change and we have a host key
  const saveActivityToHost = useCallback((entries: ActivityEntry[], hostKey: string) => {
    const atIdx = hostKey.lastIndexOf("@");
    if (atIdx < 0) return;
    const username = hostKey.slice(0, atIdx);
    const host = hostKey.slice(atIdx + 1);
    const data: ActivityEntryData[] = entries.map(e => ({
      id: e.id, type: e.type, timestamp: e.timestamp, detail: e.detail,
    }));
    const basePath = settingsRef.current.activitySavePath || "~/.weterm/activity";
    invoke("save_activity_history", { basePath, host, username, entries: data }).catch(() => {});
  }, []);

  const handleSaveSettings = useCallback(async (s: AppSettings) => {
    setSettings(s);
    invoke("save_settings", { settings: s }).catch(() => {});
  }, []);

  const handleResetDefaults = useCallback(() => {
    handleSaveSettings(DEFAULT_SETTINGS);
    // Reset CSS variables to defaults
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.setAttribute("data-theme", "dark");
  }, [handleSaveSettings]);

  // Load initial data
  useEffect(() => {
    invoke<string>("get_home_dir").then(h => setLocalPath(h + "/Desktop")).catch(() => {});
    invoke<SavedConnection[]>("load_connections").then(h => setHistory(h)).catch(() => {});
    invoke<AppSettings>("load_settings").then(s => setSettings(s)).catch(() => {});
    invoke<CustomCommand[]>("load_custom_commands").then(cmds => setCustomCommands(cmds)).catch(() => {});
  }, []);

  // CSS variable keys that custom theme can override (must match SettingsModal COLOR_VARS)
  const CUSTOM_COLOR_KEYS = ["--bg","--bg2","--bg3","--hover","--fg","--fg2","--fg3","--bd","--ac","--ac2","--red","--grn","--ylw"];

  // Apply theme & fonts from settings
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font-size", settings.uiFontSize + "px");
    document.documentElement.style.setProperty("--app-font", settings.uiFontFamily);

    // Resolve theme
    let resolved = settings.theme;
    if (resolved === "system") {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);

    // Apply or clear custom colors
    if (settings.theme === "custom" && settings.customColors) {
      try {
        const colors = JSON.parse(settings.customColors);
        for (const [key, val] of Object.entries(colors)) {
          document.documentElement.style.setProperty(key, val as string);
        }
      } catch {}
    } else {
      // Clear custom color overrides so dark/light/system themes work properly
      for (const key of CUSTOM_COLOR_KEYS) {
        document.documentElement.style.removeProperty(key);
      }
    }

    // Listen for system theme changes
    if (settings.theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => {
        document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
      };
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [settings.theme, settings.uiFontSize, settings.uiFontFamily, settings.terminalFontFamily, settings.notepadFontFamily, settings.customColors]);

  // Listen for transfer progress events.
  // Progress data (written/total/speed/eta) goes to the external progressStore
  // so only TaskPanel re-renders — NOT the entire App tree. React state is
  // only touched for structural changes (waiting → transferring status).
  useEffect(() => {
    const flush = () => {
      const updates = tpBufferRef.current;
      tpBufferRef.current = {};
      tpTimerRef.current = null;

      // 1. Write progress data to external store (TaskPanel subscribes)
      const progressUpdates: Record<string, ProgressData> = {};
      for (const [id, p] of Object.entries(updates)) {
        progressUpdates[id] = {
          written: (p as any).written ?? 0,
          total: (p as any).total ?? 0,
          speed: (p as any).speed ?? 0,
          eta: (p as any).eta ?? 0,
        };
      }
      progressStore.updateMany(progressUpdates);

      // 2. Only update React state for status transitions (waiting → transferring)
      //    and for fallback entries not yet registered.
      //    This avoids re-rendering the entire App tree on every progress tick.
      startTransition(() => {
        setTransfers(prev => {
          let changed = false;
          const next = prev.map(t => {
            const u = updates[t.id];
            if (!u) return t;
            if (t.status === "waiting") {
              changed = true;
              // Seed initial total from first progress event
              const total = (u as any).total ?? 0;
              return { ...t, status: "transferring" as const, total };
            }
            return t;
          }) as TransferItem[];
          // Fallback: add transfer items that arrived via progress before addTransfer.
          // Guard: require a "name" field to avoid resurrecting stale half-baked
          // payloads (e.g. a cross-server download just removed by transfer-complete).
          for (const [id, u] of Object.entries(updates)) {
            if (!prev.find(t => t.id === id) && (u as any).name && (u as any).total && (u as any).total > 0) {
              next.push(u as TransferItem);
              changed = true;
            }
          }
          return changed ? (next.length > 50 ? next.slice(-50) : next) : prev;
        });
      });
    };

    const unlisten = listen<TransferItem>("transfer-progress", (e) => {
      tpBufferRef.current[e.payload.id] = e.payload;
      if (!tpTimerRef.current) {
        tpTimerRef.current = setTimeout(flush, 500);
      }
    });
    return () => {
      unlisten.then(f => f());
      if (tpTimerRef.current) { clearTimeout(tpTimerRef.current); tpTimerRef.current = null; }
    };
  }, []);

  // Listen for transfer completion (from background threads)
  useEffect(() => {
    const unlisten = listen<TransferCompleteEvent>("transfer-complete", (e) => {
      const completedId = e.payload.id;
      const pending = crossRef.current[completedId];

      if (pending && e.payload.success) {
        // Cross-server: download completed, now upload.
        delete crossRef.current[completedId];
        // Clean up pending progress data so the 500ms flush timer
        // doesn't resurrect this ID via the fallback (which would add
        // a partial TransferItem without name/direction/status → crash).
        delete tpBufferRef.current[completedId];
        progressStore.remove(completedId);

        const tid2 = crypto.randomUUID();
        const targetSid = pending.targetSessionId;
        const tmpPath = pending.tmpPath;
        const remoteDest = pending.remoteDest;
        const isDir = pending.isDir;
        const uploadItem: TransferItem = {
          id: tid2, name: pending.crossName || `${pending.tmpPath} → ${pending.remoteDest}`, direction: "upload",
          written: 0, total: 0, speed: 0, eta: 0, status: "waiting",
          srcPath: pending.tmpPath, dstPath: pending.remoteDest,
          crossDir: pending.crossDir,
          sessionId: pending.targetSessionId,
        };
        uploadTempRef.current[tid2] = tmpPath;

        // Atomically remove download + add upload in one state update.
        setTransfers(prev => {
          const filtered = prev.filter(t => t.id !== completedId);
          return [...filtered, uploadItem];
        });

        // Start the upload after a microtask delay so React commits the
        // state update above before the upload thread emits any events.
        // setTimeout(..., 0) runs in the next macrotask, which is after
        // React's microtask-based state commit.
        setTimeout(() => {
          if (isDir) {
            invoke("sftp_upload_dir", { id: targetSid, localPath: tmpPath, remotePath: remoteDest, transferId: tid2 })
              .catch(() => {
                delete uploadTempRef.current[tid2];
                setTransfers(prev => prev.map(t => t.id === tid2 ? { ...t, status: "error" } : t));
                invoke("local_delete", { path: tmpPath }).catch(() => {});
              });
          } else {
            invoke("sftp_upload", { id: targetSid, localPath: tmpPath, remotePath: remoteDest, transferId: tid2 })
              .catch(() => {
                delete uploadTempRef.current[tid2];
                setTransfers(prev => prev.map(t => t.id === tid2 ? { ...t, status: "error" } : t));
                invoke("local_delete", { path: tmpPath }).catch(() => {});
              });
          }
        }, 0);
      } else if (pending && !e.payload.success) {
        // Download failed — clean up
        delete crossRef.current[completedId];
        delete tpBufferRef.current[completedId];
        progressStore.remove(completedId);
        setTransfers(prev => prev.filter(t => t.id !== completedId));
        invoke("local_delete", { path: pending.tmpPath }).catch(() => {});
      } else {
        // Regular transfer completion (single-server download/upload),
        // or cross-server upload completion.
        setTransfers(prev => prev.map(t =>
          t.id === completedId
            ? { ...t, status: e.payload.success ? "done" : "error" }
            : t
        ));
        // Clean up cross-server upload temp file immediately on completion
        const tmpPath = uploadTempRef.current[completedId];
        if (tmpPath) {
          delete uploadTempRef.current[completedId];
          // Always delete cached temp, whether upload succeeded or failed
          invoke("local_delete", { path: tmpPath }).catch(() => {});
          if (e.payload.success) {
            setRefreshKey(k => k + 1);
          }
        }
        // Auto-remove completed transfers after 5 seconds
        setTimeout(() => {
          setTransfers(prev => prev.filter(t => t.id !== completedId));
        }, 5_000);
      }
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  // Auto-save activity history when current session's entries change
  useEffect(() => {
    const hk = hostKeyRef.current;
    if (hk && activeId && activityEntries.length > 0) {
      const timer = setTimeout(() => {
        saveActivityToHost(activityEntries, hk);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [activityEntries, saveActivityToHost, activeId]);

  // Poll system info every 1 second (local Mac)
  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const raw = await invoke<string>("get_system_info");
        const [cpu, mem, total] = raw.split("|");
        setCpuPercent(cpu || "--");
        setMemUsedGb(mem || "--");
        setMemTotalGb(total || "--");
      } catch { /* ignore */ }
    }, 1000);
    return () => clearInterval(poll);
  }, []);

  // Poll remote system info every 4 seconds for the active session
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const pollRemote = async () => {
      if (cancelled) return;
      try {
        const raw = await invoke<string>("get_remote_system_info", { id: activeId });
        const [cpu, mem, total] = raw.split("|");
        if (!cancelled) {
          setSessionStates(prev => {
            const s = prev[activeId];
            if (!s) return prev;
            return { ...prev, [activeId]: { ...s, remoteCpu: cpu || "--", remoteMemGb: mem || "--", remoteMemTotalGb: total || "--" } };
          });
        }
      } catch { /* remote command may fail */ }
    };
    pollRemote(); // fire immediately
    const timer = setInterval(pollRemote, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeId]);

  const handleActivityDoubleClick = useCallback((entry: ActivityEntry) => {
    if (entry.type === "command") {
      // Paste command without executing — user presses Enter themselves
      terminalRef.current?.pasteText(entry.detail);
    } else if (activeSession) {
      // Generate SCP command from transfer detail: "srcPath → dstPath"
      const arrow = " → ";
      const idx = entry.detail.indexOf(arrow);
      const src = idx >= 0 ? entry.detail.slice(0, idx) : "";
      const dst = idx >= 0 ? entry.detail.slice(idx + arrow.length) : "";
      const conn = `${activeSession.username}@${activeSession.host}`;
      const scp = entry.type === "download"
        ? `scp ${conn}:${src} ${dst}`
        : `scp ${src} ${conn}:${dst}`;
      terminalRef.current?.pasteText(scp);
    }
  }, [activeSession]);

  // Use refs for stable callbacks — prevents cascading re-renders
  const historyRef = useRef(history);
  historyRef.current = history;

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const addTransfer = useCallback((item: TransferItem) => {
    setTransfers(prev => [...prev, { ...item, sessionId: item.sessionId ?? activeIdRef.current ?? undefined }]);
  }, []);

  const cancelTransfer = useCallback(async (id: string) => {
    try { await invoke("cancel_transfer", { transferId: id }); } catch {}
    setTransfers(prev => {
      const item = prev.find(t => t.id === id);
      // Waiting items: remove immediately (never started)
      if (item?.status === "waiting") return prev.filter(t => t.id !== id);
      // Active items: mark cancelled, auto-remove after 3s
      return prev.map(t => t.id === id ? { ...t, status: "cancelled" } : t);
    });
    setTimeout(() => setTransfers(prev => prev.filter(t => t.id !== id)), 3000);
  }, []);

  // ── Resize handlers ──
  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth(prev => Math.max(180, Math.min(500, prev + delta)));
  }, []);

  const handleRemoteResize = useCallback((delta: number) => {
    setRemoteHeight(prev => {
      const sidebar = sidebarRef.current;
      if (!sidebar) return prev;
      const sidebarH = sidebar.clientHeight;
      const remoteEl = sidebar.querySelector<HTMLElement>('.sidebar-section:first-child');
      const currentRemoteH = prev ?? (remoteEl?.clientHeight ?? sidebarH * 0.4);
      const historyEl = sidebar.querySelector<HTMLElement>('.sidebar-section-history');
      const historyH = historyEl?.offsetHeight ?? 200;
      const maxRemote = sidebarH - historyH - 140;
      return Math.max(80, Math.min(maxRemote, currentRemoteH + delta));
    });
  }, []);

  const handleActivityLogResize = useCallback((delta: number) => {
    setActivityLogWidth(prev => Math.max(0, Math.min(500, prev - delta)));
  }, []);

  const handleCommandLogResize = useCallback((delta: number) => {
    setCommandLogHeight(prev => {
      const container = rightPanelRef.current;
      if (!container) return prev;
      const containerH = container.clientHeight;
      const cmdEl = container.querySelector<HTMLElement>('.activity-log');
      const currentCmdH = prev ?? (cmdEl?.clientHeight ?? containerH * 0.45);
      const maxCmd = containerH - 120;
      return Math.max(60, Math.min(maxCmd, currentCmdH + delta));
    });
  }, []);

  // ── Activity log callbacks ──
  const addActivityEntry = useCallback((type: ActivityEntry["type"], detail: string) => {
    const max = settingsRef.current.maxSavedEntries;
    const entry: ActivityEntry = { id: crypto.randomUUID(), type, timestamp: Date.now(), detail };
    setSessionStates(prev => {
      if (!activeId) return prev;
      const cur = prev[activeId]?.activity ?? [];
      return { ...prev, [activeId]: { ...prev[activeId], activity: [entry, ...cur].slice(0, max) } };
    });
  }, [activeId]);

  const handleCommand = useCallback((command: string) => {
    addActivityEntry("command", command);
  }, [addActivityEntry]);

  const logActivity = useCallback((type: ActivityEntry["type"], detail: string) => {
    addActivityEntry(type, detail);
  }, [addActivityEntry]);

  // ── Custom command callbacks ──
  const handleAddCustomCommand = useCallback((name: string, command: string) => {
    setCustomCommands(prev => {
      const next = [...prev, { id: crypto.randomUUID(), name, command }];
      invoke("save_custom_commands", { commands: next }).catch(() => {});
      return next;
    });
  }, []);

  const handleDeleteCustomCommand = useCallback((id: string) => {
    setCustomCommands(prev => {
      const next = prev.filter(c => c.id !== id);
      invoke("save_custom_commands", { commands: next }).catch(() => {});
      return next;
    });
  }, []);

  const handleDoubleClickCustomCommand = useCallback((cmd: CustomCommand) => {
    terminalRef.current?.pasteText(cmd.command);
  }, []);

  // ── Notepad resize handler ──
  const handleNotepadResize = useCallback((delta: number) => {
    setNotepadHeight(prev => {
      const container = rightPanelRef.current;
      if (!container) return prev;
      const containerH = container.clientHeight;
      const currentH = prev ?? 160;
      const maxH = containerH - 200;
      // Notepad is at bottom; handle is its TOP edge.
      // Drag DOWN (delta>0) → shorter; drag UP (delta<0) → taller.
      return Math.max(60, Math.min(maxH, currentH - delta));
    });
  }, []);

  // const handleMonitorResize = useCallback((delta: number) => { // disabled (perf)
  //   setMonitorHeight(prev => {
  //     const container = rightPanelRef.current;
  //     if (!container) return prev;
  //     const containerH = container.clientHeight;
  //     const currentH = prev ?? 200;
  //     const maxH = containerH - 200;
  //     return Math.max(120, Math.min(maxH, currentH + delta));
  //   });
  // }, []);

  const handleConnect = useCallback(async (config: SessionConfig, setActive = true) => {
    const homePath = await invoke<string>("ssh_connect", {
      id: config.id, host: config.host, port: config.port,
      username: config.username,
      password: config.authType === "password" ? config.password : null,
      keyPath: config.authType === "key" ? config.keyPath : null,
    });
    const now = Date.now();
    const hostKey = `${config.username}@${config.host}`;

    setSessions(prev => new Map(prev).set(config.id, config));

    tabCounterRef.current += 1;
    const tabNum = tabCounterRef.current;
    setTabNumbers(prev => ({ ...prev, [config.id]: tabNum }));

    if (setActive) {
      setActiveId(config.id);
    }

    setEditor(null);
    setPrefillConn(null);

    // Initialize per-session state
    setSessionStates(prev => ({
      ...prev,
      [config.id]: {
        remotePath: homePath,
        activity: [],
        loginTime: now,
        connectedSince: now,
        hostKey,
        remoteCpu: "--",
        remoteMemGb: "--",
        remoteMemTotalGb: "--",
      },
    }));

    // Per-host activity history: load previous commands/transfers for this host
    try {
      const prevData: ActivityEntryData[] = await invoke("load_activity_history", { basePath: settingsRef.current.activitySavePath || "~/.weterm/activity", host: config.host, username: config.username });
      if (prevData.length > 0) {
        const maxSaved = settingsRef.current.maxSavedEntries;
        const loaded = prevData.map(e => ({ ...e, type: e.type as ActivityEntry["type"] })) as ActivityEntry[];
        setSessionStates(prevS => {
          const s = prevS[config.id];
          if (!s) return prevS;
          const merged = [...loaded.reverse(), ...s.activity];
          const seen = new Set<string>();
          const deduped = merged.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
          return { ...prevS, [config.id]: { ...s, activity: deduped.slice(0, maxSaved) } };
        });
      }
    } catch { /* no history yet */ }

    // Save password to macOS Keychain (encrypted, not plaintext)
    if (config.authType === "password" && config.password) {
      invoke("keychain_save", { username: config.username, host: config.host, password: config.password }).catch(() => {});
    }

    const saved: SavedConnection = {
      name: config.name, host: config.host, port: config.port,
      username: config.username, authType: config.authType,
      keyPath: config.authType === "key" ? config.keyPath : undefined,
      hasKeychainSecret: config.authType === "password",
    };
    const cur = historyRef.current;
    const newHistory = [saved, ...cur.filter(h => h.host !== config.host || h.username !== config.username)].slice(0, 20);
    setHistory(newHistory);
    invoke("save_connections", { list: newHistory }).catch(() => {});

    return homePath;
  }, []);

  // Update a saved connection (edit nickname, password, host, etc.)
  const handleUpdateConnection = useCallback((old: SavedConnection, updated: SavedConnection, newPassword?: string) => {
    // Handle keychain: if password provided, save it; if host/user changed, clean old entry
    if (newPassword) {
      invoke("keychain_save", { username: updated.username, host: updated.host, password: newPassword }).catch(() => {});
    } else if (old.hasKeychainSecret && (old.username !== updated.username || old.host !== updated.host)) {
      // Keychain entry is keyed by username+host — if either changed with no new password, orphan old one
      invoke("keychain_delete", { username: old.username, host: old.host }).catch(() => {});
    }
    const newHistory = history.map(h =>
      (h.host === old.host && h.username === old.username) ? updated : h
    );
    setHistory(newHistory);
    invoke("save_connections", { list: newHistory }).catch(() => {});
  }, [history]);

  // Delete a saved connection
  const handleDeleteConnection = useCallback((saved: SavedConnection) => {
    if (saved.hasKeychainSecret) {
      invoke("keychain_delete", { username: saved.username, host: saved.host }).catch(() => {});
    }
    const newHistory = history.filter(h => h.host !== saved.host || h.username !== saved.username);
    setHistory(newHistory);
    invoke("save_connections", { list: newHistory }).catch(() => {});
  }, [history]);

  const handleDisconnect = useCallback(async (id: string) => {
    // Save activity history one last time before disconnecting
    const ss = sessionRef.current[id];
    if (ss?.hostKey) {
      saveActivityToHost(ss.activity, ss.hostKey);
    }
    try { await invoke("ssh_disconnect", { id }); } catch (_) {}
    setSessions(prev => { const n = new Map(prev); n.delete(id); return n; });
    setSessionStates(prev => { const n = { ...prev }; delete n[id]; return n; });
    setTabNumbers(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (activeId === id) {
      setActiveId(null);
    }
    // If bottom panel was connected to this session, revert to local
    setBottomConn(prev => prev.type === "remote" && prev.sessionId === id ? { type: "local" } : prev);
    setEditor(null);
  }, [activeId, saveActivityToHost]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Cmd+, → open settings
      if (e.key === ",") { e.preventDefault(); setShowSettings(true); return; }

      // Only handle tab shortcuts when there are active sessions
      const sessionIds = Array.from(sessions.keys());
      if (sessionIds.length === 0) return;

      // Cmd+W → close active tab
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        if (activeId) handleDisconnect(activeId);
        return;
      }

      // Cmd+1-9 → switch to tab
      const num = parseInt(e.key);
      if (num >= 1 && num <= 9 && num <= sessionIds.length) {
        e.preventDefault();
        setActiveId(sessionIds[num - 1]);
        return;
      }

      // Cmd+[ → previous tab
      if (e.key === "[" && activeId) {
        e.preventDefault();
        const idx = sessionIds.indexOf(activeId);
        if (idx > 0) setActiveId(sessionIds[idx - 1]);
        return;
      }

      // Cmd+] → next tab
      if (e.key === "]" && activeId) {
        e.preventDefault();
        const idx = sessionIds.indexOf(activeId);
        if (idx >= 0 && idx < sessionIds.length - 1) setActiveId(sessionIds[idx + 1]);
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sessions, activeId, handleDisconnect]);

  // ── Connection picker callbacks ──
  const handlePickerConnect = useCallback(async (config: SessionConfig) => {
    if (pickerPanel === "top") {
      await handleConnect(config, true);
    } else {
      // Bottom panel: connect without making it the active tab
      await handleConnect(config, false);
      setBottomConn({ type: "remote", sessionId: config.id });
    }
  }, [pickerPanel, handleConnect]);

  const handlePickerReconnect = useCallback(async (saved: SavedConnection) => {
    if (saved.authType === "agent") {
      const id = crypto.randomUUID();
      const config: SessionConfig = {
        id, name: saved.name, host: saved.host, port: saved.port,
        username: saved.username, authType: "agent",
      };
      try { await handlePickerConnect(config); } catch (e) { showToast(String(e)); }
      return;
    }

    if (saved.authType === "key" && saved.keyPath) {
      const id = crypto.randomUUID();
      const config: SessionConfig = {
        id, name: saved.name, host: saved.host, port: saved.port,
        username: saved.username, authType: "key", keyPath: saved.keyPath,
      };
      try { await handlePickerConnect(config); } catch (e) { showToast(String(e)); }
      return;
    }

    if (saved.authType === "password" && saved.hasKeychainSecret) {
      try {
        const pw = await invoke<string>("keychain_get", { username: saved.username, host: saved.host });
        const id = crypto.randomUUID();
        const config: SessionConfig = {
          id, name: saved.name, host: saved.host, port: saved.port,
          username: saved.username, authType: "password", password: pw,
        };
        await handlePickerConnect(config);
        return;
      } catch { /* fall through to prefill */ }
    }

    // Key auth or password without keychain — prefill the connection modal
    setPrefillConn(saved);
  }, [handlePickerConnect]);

  const handlePickerLocal = useCallback(() => {
    if (pickerPanel === "top") {
      // Switch top panel to local — clear active session
      if (activeId) {
        setActiveId(null);
      }
    } else {
      // Switch bottom panel to local
      setBottomConn({ type: "local" });
    }
  }, [pickerPanel, activeId]);

  // Right-click reconnect: disconnect then reconnect the same session, preserving path
  const handleReconnectSession = useCallback(async (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    // Save current path before disconnecting
    const targetPath = sessionStates[id]?.remotePath ?? "/";
    // Save activity before disconnecting
    const ss = sessionRef.current[id];
    if (ss?.hostKey) saveActivityToHost(ss.activity, ss.hostKey);
    try { await invoke("ssh_disconnect", { id }); } catch (_) {}
    setSessions(prev => { const n = new Map(prev); n.delete(id); return n; });
    setSessionStates(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (activeId === id) setActiveId(null);
    // Reconnect with new ID, then restore the previous working directory
    const newId = crypto.randomUUID();
    try {
      await handleConnect({ ...session, id: newId });
      // Override remote path after connect sets it to home
      setSessionStates(prev => {
        const s = prev[newId];
        if (!s) return prev;
        return { ...prev, [newId]: { ...s, remotePath: targetPath } };
      });
    } catch (e) { showToast(String(e)); }
  }, [sessions, activeId, sessionStates, handleConnect, saveActivityToHost]);

  // Clone tab: create a new connection with same settings and navigate to same path
  const handleCloneTab = useCallback(async (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    const targetPath = sessionStates[id]?.remotePath ?? "/";
    const config: SessionConfig = {
      ...session,
      id: crypto.randomUUID(),
      name: `${session.username}@${session.host}:${session.port}`,
    };
    try {
      await handleConnect(config);
      // Override remote path after connect sets it to home
      setSessionStates(prev => {
        const s = prev[config.id];
        if (!s) return prev;
        return { ...prev, [config.id]: { ...s, remotePath: targetPath } };
      });
    } catch (e) { showToast(String(e)); }
  }, [sessions, sessionStates, handleConnect]);

  // Remote file copy/paste (Fix 6)
  const handleRemoteCopy = useCallback((file: FileEntry) => {
    setRemoteClipboard({ path: file.path, name: file.name });
  }, []);

  const handleRemotePaste = useCallback(async () => {
    if (!remoteClipboard || !activeId) return;
    const dest = remotePath + "/" + remoteClipboard.name;
    try {
      await invoke("ssh_execute", { id: activeId, command: `cp -r "${remoteClipboard.path}" "${dest}"` });
      setRefreshKey(k => k + 1);
    } catch (e) { showToast(String(e)); }
  }, [remoteClipboard, activeId, remotePath]);

  // Navigate remote path (per-session)
  const handleNavigate = useCallback((p: string) => {
    if (!activeId) return;
    setSessionStates(prev => {
      const s = prev[activeId];
      if (!s) return prev;
      return { ...prev, [activeId]: { ...s, remotePath: p } };
    });
  }, [activeId]);

  // Returns the resolved filename (same or with " (copy)"), or null if cancelled
  const resolveConflict = useCallback(async (
    isRemote: boolean, sessionId: string | null,
    parentDir: string, fileName: string,
  ): Promise<string | null> => {
    try {
      const files = isRemote && sessionId
        ? await invoke<FileEntry[]>("sftp_list_files", { id: sessionId, path: parentDir })
        : await invoke<FileEntry[]>("local_list_files", { path: parentDir });
      if (!files.some(f => f.name === fileName)) return fileName; // no conflict
    } catch { return fileName; } // can't check, proceed

    // Conflict exists — show modal and wait for user choice
    return new Promise((resolve) => {
      const copyName = fileName.replace(/(\.[^./]+)$/, ' (copy)$1') || fileName + ' (copy)';
      setConflict({
        fileName, copyName,
        onReplace: () => { setConflict(null); resolve(fileName); },
        onRename: () => { setConflict(null); resolve(copyName); },
        onCancel: () => { setConflict(null); resolve(null); },
      });
    });
  }, []);

  // ── Context menu handlers (fire-and-forget transfers) ──
  const handleContextUpload = useCallback(async (file: FileEntry) => {
    if (!activeId) return;
    const resolvedName = await resolveConflict(true, activeId, remotePath, file.name);
    if (resolvedName === null) return;
    const tid = crypto.randomUUID();
    const dst = remotePath + "/" + resolvedName;
    addTransfer({ id: tid, name: `${file.path} → ${dst}`, direction: "upload", written: 0, total: 0, speed: 0, eta: 0, status: "waiting", srcPath: file.path, dstPath: dst });
    logActivity("upload", `${file.path} → ${dst}`);
    await new Promise(r => setTimeout(r, 500));
    if (file.is_dir) {
      invoke("sftp_upload_dir", { id: activeId, localPath: file.path, remotePath: dst, transferId: tid })
        .then(() => setRefreshKey(k => k + 1))
        .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
    } else {
      invoke("sftp_upload", { id: activeId, localPath: file.path, remotePath: dst, transferId: tid })
        .then(() => setRefreshKey(k => k + 1))
        .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
    }
  }, [activeId, remotePath, addTransfer, logActivity, resolveConflict]);

  const handleContextDownload = useCallback(async (file: FileEntry) => {
    if (!activeId) return;
    const resolvedName = await resolveConflict(false, null, bottomLocalPath, file.name);
    if (resolvedName === null) return;
    const tid = crypto.randomUUID();
    const dst = bottomLocalPath + "/" + resolvedName;
    addTransfer({ id: tid, name: `${file.path} → ${dst}`, direction: "download", written: 0, total: 0, speed: 0, eta: 0, status: "waiting", srcPath: file.path, dstPath: dst });
    logActivity("download", `${file.path} → ${dst}`);
    await new Promise(r => setTimeout(r, 500));
    if (file.is_dir) {
      invoke("sftp_download_dir", { id: activeId, remotePath: file.path, localPath: dst, transferId: tid })
        .then(() => setRefreshKey(k => k + 1))
        .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
    } else {
      invoke("sftp_download", { id: activeId, remotePath: file.path, localPath: dst, transferId: tid })
        .then(() => setRefreshKey(k => k + 1))
        .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
    }
  }, [activeId, bottomLocalPath, addTransfer, logActivity, resolveConflict]);

  // ── Bottom remote panel handlers (mirrors top panel, uses bottomConn.sessionId) ──
  const handleBottomContextDownload = useCallback(async (file: FileEntry) => {
    if (bottomConn.type !== "remote") return;
    const resolvedName = await resolveConflict(false, null, bottomLocalPath, file.name);
    if (resolvedName === null) return;
    const tid = crypto.randomUUID();
    const dst = bottomLocalPath + "/" + resolvedName;
    addTransfer({ id: tid, name: `${file.path} → ${dst}`, direction: "download", written: 0, total: 0, speed: 0, eta: 0, status: "waiting", srcPath: file.path, dstPath: dst, sessionId: bottomConn.sessionId });
    logActivity("download", `${file.path} → ${dst}`);
    await new Promise(r => setTimeout(r, 500));
    if (file.is_dir) {
      invoke("sftp_download_dir", { id: bottomConn.sessionId, remotePath: file.path, localPath: dst, transferId: tid })
        .then(() => setRefreshKey(k => k + 1))
        .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
    } else {
      invoke("sftp_download", { id: bottomConn.sessionId, remotePath: file.path, localPath: dst, transferId: tid })
        .then(() => setRefreshKey(k => k + 1))
        .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
    }
  }, [bottomConn, bottomLocalPath, addTransfer, logActivity, resolveConflict]);

  const handleBottomBatchDownload = useCallback(async (items: FileEntry[]) => {
    if (bottomConn.type !== "remote") return;
    const existingNames = await invoke<FileEntry[]>("local_list_files", { path: bottomLocalPath })
      .then(r => new Set(r.map(f => f.name)))
      .catch(() => new Set<string>());
    const getSafeName = (name: string): string => {
      if (!existingNames.has(name)) { existingNames.add(name); return name; }
      const dotIdx = name.lastIndexOf(".");
      const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
      let n = 1; while (existingNames.has(`${base} (${n})${ext}`)) n++;
      const safe = `${base} (${n})${ext}`; existingNames.add(safe); return safe;
    };
    const pending: { tid: string; file: FileEntry; dst: string }[] = [];
    for (const f of items) {
      const tid = crypto.randomUUID();
      const dst = bottomLocalPath + "/" + getSafeName(f.name);
      addTransfer({ id: tid, name: `${f.path} → ${dst}`, direction: "download", written: 0, total: 0, speed: 0, eta: 0, status: "waiting", srcPath: f.path, dstPath: dst, sessionId: bottomConn.sessionId });
      logActivity("download", `${f.path} → ${dst}`);
      pending.push({ tid, file: f, dst });
    }
    for (const p of pending) {
      await new Promise(r => setTimeout(r, 500));
      if (p.file.is_dir) {
        invoke("sftp_download_dir", { id: bottomConn.sessionId, remotePath: p.file.path, localPath: p.dst, transferId: p.tid })
          .then(() => setRefreshKey(k => k + 1))
          .catch(() => setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t)));
      } else {
        invoke("sftp_download", { id: bottomConn.sessionId, remotePath: p.file.path, localPath: p.dst, transferId: p.tid })
          .then(() => setRefreshKey(k => k + 1))
          .catch(() => setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t)));
      }
    }
  }, [bottomConn, bottomLocalPath, addTransfer, logActivity]);

  // ── Recap recording callbacks ──
  const handleRecordingData = useCallback((data: string, type: "output" | "input") => {
    const rec = recordingRef.current;
    if (!rec) return;
    const t = Date.now() - rec.startedAt;
    // Merge if last event is same type and within 50ms
    setRecording(prev => {
      if (!prev) return prev;
      const events = [...prev.events];
      const last = events[events.length - 1];
      if (last && last.type === type && t - last.t < 50) {
        events[events.length - 1] = { ...last, d: last.d + data };
      } else {
        events.push({ t, d: data, type });
      }
      return { ...prev, events };
    });
  }, []);

  const startRecording = useCallback(() => {
    if (!activeSession) return;
    setRecording({
      sessionId: activeSession.id,
      sessionName: `${activeSession.username}@${activeSession.host}:${activeSession.port}`,
      startedAt: Date.now(),
      events: [],
    });
  }, [activeSession]);

  const stopRecording = useCallback(async () => {
    const rec = recordingRef.current;
    if (!rec || rec.events.length === 0) { setRecording(null); return; }
    // Compact before saving: merge consecutive same-type events within 200ms
    const compacted: RecapEvent[] = [];
    for (const e of rec.events) {
      const last = compacted[compacted.length - 1];
      if (last && last.type === e.type && e.t - last.t < 200) {
        compacted[compacted.length - 1] = { ...last, d: last.d + e.d };
      } else {
        compacted.push({ ...e });
      }
    }
    try {
      await invoke("save_recording", {
        id: rec.sessionId + "_" + rec.startedAt,
        name: rec.sessionName + " " + new Date(rec.startedAt).toLocaleString(),
        session: rec.sessionName,
        startedAt: rec.startedAt,
        events: compacted,
      });
    } catch (e) { console.error("Save recording failed:", e); }
    setRecording(null);
  }, []);

  const handleContextDelete = useCallback(async (file: FileEntry, type: "remote" | "local") => {
    try {
      if (type === "remote") {
        await invoke("sftp_delete", { id: activeId, path: file.path });
      } else {
        await invoke("local_delete", { path: file.path });
      }
      setRefreshKey(k => k + 1);
    } catch (e) { showToast(String(e)); }
  }, [activeId]);

  const handleRemoteRename = useCallback((file: FileEntry) => {
    setNamePrompt({
      title: "Rename Remote Item",
      label: "New name",
      initialValue: file.name,
      onSubmit: async (newName) => {
        if (!newName || newName === file.name) return;
        const parent = file.path.substring(0, file.path.lastIndexOf("/")) || "/";
        const newPath = parent + "/" + newName;
        await invoke("sftp_rename", { id: activeId, oldPath: file.path, newPath });
        setRefreshKey(k => k + 1);
      },
    });
  }, [activeId]);

  const handleLocalRename = useCallback((file: FileEntry) => {
    setNamePrompt({
      title: "Rename Local Item",
      label: "New name",
      initialValue: file.name,
      onSubmit: async (newName) => {
        if (!newName || newName === file.name) return;
        const parent = file.path.substring(0, file.path.lastIndexOf("/")) || "/";
        const newPath = parent + "/" + newName;
        await invoke("local_rename", { oldPath: file.path, newPath });
        setRefreshKey(k => k + 1);
      },
    });
  }, []);

  const handleRemoteNewFolder = useCallback(() => {
    setNamePrompt({
      title: "New Remote Folder",
      label: "Folder name",
      initialValue: "",
      onSubmit: async (name) => {
        const path = (remotePath + "/" + name).replace(/\/+/g, "/");
        await invoke("sftp_create_dir", { id: activeId, path });
        setRefreshKey(k => k + 1);
      },
    });
  }, [activeId, remotePath]);

  const handleLocalNewFolder = useCallback(() => {
    setNamePrompt({
      title: "New Local Folder",
      label: "Folder name",
      initialValue: "",
      onSubmit: async (name) => {
        const path = (bottomLocalPath + "/" + name).replace(/\/+/g, "/");
        await invoke("local_create_dir", { path });
        setRefreshKey(k => k + 1);
      },
    });
  }, [bottomLocalPath]);

  const handleBottomRemoteRename = useCallback((file: FileEntry) => {
    if (bottomConn.type !== "remote") return;
    setNamePrompt({
      title: "Rename Remote Item",
      label: "New name",
      initialValue: file.name,
      onSubmit: async (newName) => {
        if (!newName || newName === file.name) return;
        const parent = file.path.substring(0, file.path.lastIndexOf("/")) || "/";
        const newPath = parent + "/" + newName;
        await invoke("sftp_rename", { id: bottomConn.sessionId, oldPath: file.path, newPath });
        setRefreshKey(k => k + 1);
      },
    });
  }, [bottomConn]);

  const handleBottomRemoteNewFolder = useCallback(() => {
    if (bottomConn.type !== "remote") return;
    setNamePrompt({
      title: "New Remote Folder",
      label: "Folder name",
      initialValue: "",
      onSubmit: async (name) => {
        const path = (bottomRemotePath + "/" + name).replace(/\/+/g, "/");
        await invoke("sftp_create_dir", { id: bottomConn.sessionId, path });
        setRefreshKey(k => k + 1);
      },
    });
  }, [bottomConn, bottomRemotePath]);

  // ── Batch multi-select handlers (two-phase: show all in Tasks, then start) ──
  // Each handler accepts mixed FileEntry[] (files + dirs) and routes to the right command per item.
  const startDownloadsTo = useCallback(async (items: FileEntry[], localDir: string) => {
    if (!activeId) return;
    const existingNames = await invoke<FileEntry[]>("local_list_files", { path: localDir })
      .then(r => new Set(r.map(f => f.name)))
      .catch(() => new Set<string>());
    const getSafeName = (name: string): string => {
      if (!existingNames.has(name)) { existingNames.add(name); return name; }
      const dotIdx = name.lastIndexOf(".");
      const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
      let n = 1; while (existingNames.has(`${base} (${n})${ext}`)) n++;
      const safe = `${base} (${n})${ext}`; existingNames.add(safe); return safe;
    };
    const pending: { tid: string; file: FileEntry; dst: string }[] = [];
    for (const f of items) {
      const tid = crypto.randomUUID();
      const dst = localDir + "/" + getSafeName(f.name);
      addTransfer({ id: tid, name: `${f.path} → ${dst}`, direction: "download", written: 0, total: 0, speed: 0, eta: 0, status: "waiting", srcPath: f.path, dstPath: dst });
      logActivity("download", `${f.path} → ${dst}`);
      pending.push({ tid, file: f, dst });
    }
    for (const p of pending) {
      await new Promise(r => setTimeout(r, 500));
      if (p.file.is_dir) {
        invoke("sftp_download_dir", { id: activeId, remotePath: p.file.path, localPath: p.dst, transferId: p.tid })
          .then(() => setRefreshKey(k => k + 1))
          .catch(() => setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t)));
      } else {
        invoke("sftp_download", { id: activeId, remotePath: p.file.path, localPath: p.dst, transferId: p.tid })
          .then(() => setRefreshKey(k => k + 1))
          .catch(() => setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t)));
      }
    }
  }, [activeId, addTransfer, logActivity]);

  const handleBatchDownload = useCallback(async (items: FileEntry[]) => {
    await startDownloadsTo(items, bottomLocalPath);
  }, [bottomLocalPath, startDownloadsTo]);

  /// Fallback for dragging a remote file out of the window: let the user pick
  /// the destination folder (Desktop, Downloads, etc.) and download there.
  const handleDragOutDownload = useCallback(async (files: FileEntry[]) => {
    if (!activeId || files.length === 0) return;
    const dir = await open({
      directory: true,
      title: "Choose Download Folder",
      defaultPath: "~/Downloads",
    });
    if (!dir || Array.isArray(dir)) return;
    await startDownloadsTo(files, dir);
  }, [activeId, startDownloadsTo]);

  const handleBatchUpload = useCallback(async (items: FileEntry[]) => {
    if (!activeId) return;
    const existingNames = await invoke<FileEntry[]>("sftp_list_files", { id: activeId, path: remotePath })
      .then(r => new Set(r.map(f => f.name)))
      .catch(() => new Set<string>());
    const getSafeName = (name: string): string => {
      if (!existingNames.has(name)) { existingNames.add(name); return name; }
      const dotIdx = name.lastIndexOf(".");
      const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
      let n = 1; while (existingNames.has(`${base} (${n})${ext}`)) n++;
      const safe = `${base} (${n})${ext}`; existingNames.add(safe); return safe;
    };
    const pending: { tid: string; file: FileEntry; dst: string }[] = [];
    for (const f of items) {
      const tid = crypto.randomUUID();
      const dst = remotePath + "/" + getSafeName(f.name);
      addTransfer({ id: tid, name: `${f.path} → ${dst}`, direction: "upload", written: 0, total: 0, speed: 0, eta: 0, status: "waiting", srcPath: f.path, dstPath: dst });
      logActivity("upload", `${f.path} → ${dst}`);
      pending.push({ tid, file: f, dst });
    }
    for (const p of pending) {
      await new Promise(r => setTimeout(r, 500));
      if (p.file.is_dir) {
        invoke("sftp_upload_dir", { id: activeId, localPath: p.file.path, remotePath: p.dst, transferId: p.tid })
          .then(() => setRefreshKey(k => k + 1))
          .catch(() => setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t)));
      } else {
        invoke("sftp_upload", { id: activeId, localPath: p.file.path, remotePath: p.dst, transferId: p.tid })
          .then(() => setRefreshKey(k => k + 1))
          .catch(() => setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t)));
      }
    }
  }, [activeId, remotePath, addTransfer, logActivity]);

  // ── Cross-server transfer helpers ──
  // Generic: download from source server to temp, then auto-upload to target server
  // The transfer-complete listener handles the upload leg via crossRef
  const doCrossServerTransfer = useCallback(async (
    srcSessionId: string,
    srcPath: string,
    srcName: string,
    isDir: boolean,
    targetSessionId: string,
    targetRemotePath: string,
    targetName: string,
    crossDir: "to-top" | "to-bottom",
  ) => {
    const h = await invoke<string>("get_home_dir").catch(() => "/tmp");
    const tmpDir = h + "/weterm-temp";
    try { await invoke("local_create_dir", { path: tmpDir }); } catch {}
    const resolvedName = await resolveConflict(true, targetSessionId, targetRemotePath, srcName);
    if (resolvedName === null) return;
    const tmpPath = tmpDir + "/" + resolvedName;
    const remoteDest = targetRemotePath + "/" + resolvedName;
    const crossName = `${srcPath} → ${remoteDest} (via ${targetName})`;
    const tid = crypto.randomUUID();
    addTransfer({
      id: tid, name: crossName, direction: "download",
      written: 0, total: 0, speed: 0, eta: 0, status: "waiting",
      srcPath: srcPath, dstPath: remoteDest, crossDir,
    });
    logActivity("download", `${srcPath} → ${remoteDest} (via temp)`);
    // Show as waiting briefly, then start
    await new Promise(r => setTimeout(r, 500));
    crossRef.current[tid] = {
      targetSessionId, tmpPath, remoteDest, name: resolvedName, crossName, crossDir, isDir,
    };
    if (isDir) {
      invoke("sftp_download_dir", { id: srcSessionId, remotePath: srcPath, localPath: tmpPath, transferId: tid })
        .catch(() => {
          delete crossRef.current[tid];
          setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t));
        });
    } else {
      invoke("sftp_download", { id: srcSessionId, remotePath: srcPath, localPath: tmpPath, transferId: tid })
        .catch(() => {
          delete crossRef.current[tid];
          setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t));
        });
    }
  }, [addTransfer, logActivity, resolveConflict]);

  // Cross-server from TOP remote → BOTTOM remote
  const handleTopCrossTransfer = useCallback(async (file: FileEntry) => {
    if (!activeId || bottomConn.type !== "remote") return;
    const targetName = sessions.get(bottomConn.sessionId)?.host || bottomConn.sessionId;
    await doCrossServerTransfer(activeId, file.path, file.name, file.is_dir,
      bottomConn.sessionId, bottomRemotePath, targetName, "to-bottom");
  }, [activeId, bottomConn, bottomRemotePath, sessions, doCrossServerTransfer]);

  // Cross-server from BOTTOM remote → TOP remote
  const handleBottomCrossTransfer = useCallback(async (file: FileEntry) => {
    if (!activeId || bottomConn.type !== "remote") return;
    const targetName = sessions.get(activeId)?.host || activeId;
    await doCrossServerTransfer(bottomConn.sessionId, file.path, file.name, file.is_dir,
      activeId, remotePath, targetName, "to-top");
  }, [activeId, bottomConn, remotePath, sessions, doCrossServerTransfer]);

  // Batch cross-server handlers (accept mixed files + dirs)
  const handleTopCrossTransferBatch = useCallback(async (items: FileEntry[]) => {
    if (!activeId || bottomConn.type !== "remote") return;
    const targetName = sessions.get(bottomConn.sessionId)?.host || bottomConn.sessionId;
    const existingNames = await invoke<FileEntry[]>("sftp_list_files", { id: bottomConn.sessionId, path: bottomRemotePath })
      .then(r => new Set(r.map(f => f.name)))
      .catch(() => new Set<string>());
    const getSafeName = (name: string): string => {
      if (!existingNames.has(name)) { existingNames.add(name); return name; }
      const dotIdx = name.lastIndexOf(".");
      const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
      let n = 1; while (existingNames.has(`${base} (${n})${ext}`)) n++;
      const safe = `${base} (${n})${ext}`; existingNames.add(safe); return safe;
    };
    const pending: { file: FileEntry; tid: string; safeName: string }[] = [];
    for (const f of items) {
      const safeName = getSafeName(f.name);
      const tid = crypto.randomUUID();
      addTransfer({
        id: tid, name: `${f.path} → ${bottomRemotePath}/${safeName} (via ${targetName})`,
        direction: "download", written: 0, total: 0, speed: 0, eta: 0, status: "waiting",
        srcPath: f.path, dstPath: bottomRemotePath + "/" + safeName, crossDir: "to-bottom",
      });
      logActivity("download", `${f.path} → ${bottomRemotePath}/${safeName} (via temp)`);
      pending.push({ file: f, tid, safeName });
    }
    const h = await invoke<string>("get_home_dir").catch(() => "/tmp");
    const tmpDir = h + "/weterm-temp";
    try { await invoke("local_create_dir", { path: tmpDir }); } catch {}
    for (const p of pending) {
      await new Promise(r => setTimeout(r, 500));
      const tmpPath = tmpDir + "/" + p.safeName;
      crossRef.current[p.tid] = {
        targetSessionId: bottomConn.sessionId, tmpPath,
        remoteDest: bottomRemotePath + "/" + p.safeName,
        name: p.safeName,
        crossName: `${p.file.path} → ${bottomRemotePath}/${p.safeName} (via ${targetName})`,
        crossDir: "to-bottom" as const, isDir: p.file.is_dir,
      };
      if (p.file.is_dir) {
        invoke("sftp_download_dir", { id: activeId, remotePath: p.file.path, localPath: tmpPath, transferId: p.tid })
          .catch(() => {
            delete crossRef.current[p.tid];
            setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t));
          });
      } else {
        invoke("sftp_download", { id: activeId, remotePath: p.file.path, localPath: tmpPath, transferId: p.tid })
          .catch(() => {
            delete crossRef.current[p.tid];
            setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t));
          });
      }
    }
  }, [activeId, bottomConn, bottomRemotePath, sessions, addTransfer, logActivity]);

  const handleBottomCrossTransferBatch = useCallback(async (items: FileEntry[]) => {
    if (!activeId || bottomConn.type !== "remote") return;
    const targetName = sessions.get(activeId)?.host || activeId;
    const existingNames = await invoke<FileEntry[]>("sftp_list_files", { id: activeId, path: remotePath })
      .then(r => new Set(r.map(f => f.name)))
      .catch(() => new Set<string>());
    const getSafeName = (name: string): string => {
      if (!existingNames.has(name)) { existingNames.add(name); return name; }
      const dotIdx = name.lastIndexOf(".");
      const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
      let n = 1; while (existingNames.has(`${base} (${n})${ext}`)) n++;
      const safe = `${base} (${n})${ext}`; existingNames.add(safe); return safe;
    };
    const pending: { file: FileEntry; tid: string; safeName: string }[] = [];
    for (const f of items) {
      const safeName = getSafeName(f.name);
      const tid = crypto.randomUUID();
      addTransfer({
        id: tid, name: `${f.path} → ${remotePath}/${safeName} (via ${targetName})`,
        direction: "download", written: 0, total: 0, speed: 0, eta: 0, status: "waiting",
        srcPath: f.path, dstPath: remotePath + "/" + safeName, crossDir: "to-top" as const,
      });
      logActivity("download", `${f.path} → ${remotePath}/${safeName} (via temp)`);
      pending.push({ file: f, tid, safeName });
    }
    const h = await invoke<string>("get_home_dir").catch(() => "/tmp");
    const tmpDir = h + "/weterm-temp";
    try { await invoke("local_create_dir", { path: tmpDir }); } catch {}
    for (const p of pending) {
      await new Promise(r => setTimeout(r, 500));
      const tmpPath = tmpDir + "/" + p.safeName;
      crossRef.current[p.tid] = {
        targetSessionId: activeId, tmpPath,
        remoteDest: remotePath + "/" + p.safeName,
        name: p.safeName,
        crossName: `${p.file.path} → ${remotePath}/${p.safeName} (via ${targetName})`,
        crossDir: "to-top" as const, isDir: p.file.is_dir,
      };
      if (p.file.is_dir) {
        invoke("sftp_download_dir", { id: bottomConn.sessionId, remotePath: p.file.path, localPath: tmpPath, transferId: p.tid })
          .catch(() => {
            delete crossRef.current[p.tid];
            setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t));
          });
      } else {
        invoke("sftp_download", { id: bottomConn.sessionId, remotePath: p.file.path, localPath: tmpPath, transferId: p.tid })
          .catch(() => {
            delete crossRef.current[p.tid];
            setTransfers(prev => prev.map(t => t.id === p.tid ? { ...t, status: "error" } : t));
          });
      }
    }
  }, [activeId, bottomConn, remotePath, sessions, addTransfer, logActivity]);

  // ── Drag-and-drop ──

  /// Resolve file paths from text/uri-list (Finder drag-in) or DataTransfer files
  const resolveExternalPaths = useCallback(async (e: React.DragEvent): Promise<string[]> => {
    // Try text/uri-list first (most reliable across platforms)
    let uriList = "";
    try { uriList = e.dataTransfer.getData("text/uri-list"); } catch { /* WKWebView may block getData */ }
    if (uriList) {
      return uriList.split('\n')
        .map(u => u.trim())
        .filter(u => u.startsWith('file://'))
        .map(u => {
          let path = u.replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, '');
          // Decode percent-encoded characters but keep slashes
          try { return decodeURIComponent(path); } catch { return path; }
        })
        .filter(p => p && p !== '/');
    }
    // Fallback: try HTML5 File API (works in some WKWebView builds)
    try {
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const paths: string[] = [];
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          const f = e.dataTransfer.files[i];
          // @ts-expect-error: webkitRelativePath or path may exist
          const p = f.path || f.webkitRelativePath || null;
          if (p) paths.push(p);
        }
        return paths;
      }
    } catch { /* fall through */ }
    return [];
  }, []);

  /// Shared Finder→Weterm upload logic used by both HTML5 drops and Tauri
  /// native file-drop events.
  const uploadExternalPaths = useCallback(async (targetPanel: "top" | "bottom", paths: string[]) => {
    if (!paths.length) return;
    // Avoid double-handling when both native and HTML5 drop events fire.
    const key = JSON.stringify(paths);
    if ((window as any).__weterm_last_ext_paths === key) return;
    (window as any).__weterm_last_ext_paths = key;

    const items: FileEntry[] = [];
    for (const fpath of paths) {
      try {
        const parent = fpath.substring(0, fpath.lastIndexOf('/')) || '/';
        const fname = fpath.substring(fpath.lastIndexOf('/') + 1);
        const dirFiles = await invoke<FileEntry[]>("local_list_files", { path: parent });
        const found = dirFiles.find((f: FileEntry) => f.name === fname);
        if (found) items.push(found);
      } catch { /* skip unresolvable files */ }
    }
    if (items.length === 0) return;

    if (targetPanel === "top" && activeId) {
      const existingNames = await invoke<FileEntry[]>("sftp_list_files", { id: activeId, path: remotePath })
        .then(r => new Set(r.map(f => f.name))).catch(() => new Set<string>());
      const getSafeName = (name: string): string => {
        if (!existingNames.has(name)) { existingNames.add(name); return name; }
        const dotIdx = name.lastIndexOf(".");
        const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
        const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
        let n = 1; while (existingNames.has(`${base} (${n})${ext}`)) n++;
        const safe = `${base} (${n})${ext}`; existingNames.add(safe); return safe;
      };
      for (const f of items) {
        const tid = crypto.randomUUID();
        const dst = remotePath + "/" + getSafeName(f.name);
        addTransfer({ id: tid, name: `${f.path} → ${dst}`, direction: "upload", written: 0, total: 0, speed: 0, eta: 0, status: "waiting", srcPath: f.path, dstPath: dst });
        logActivity("upload", `${f.path} → ${dst}`);
        await new Promise(r => setTimeout(r, 500));
        if (f.is_dir) {
          invoke("sftp_upload_dir", { id: activeId, localPath: f.path, remotePath: dst, transferId: tid })
            .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
        } else {
          invoke("sftp_upload", { id: activeId, localPath: f.path, remotePath: dst, transferId: tid })
            .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
        }
      }
      setRefreshKey(k => k + 1);
      return;
    }

    if (targetPanel === "bottom" && bottomConn.type === "remote" && bottomConn.sessionId) {
      const existingNames = await invoke<FileEntry[]>("sftp_list_files", { id: bottomConn.sessionId, path: bottomRemotePath })
        .then(r => new Set(r.map(f => f.name))).catch(() => new Set<string>());
      const getSafeName = (name: string): string => {
        if (!existingNames.has(name)) { existingNames.add(name); return name; }
        const dotIdx = name.lastIndexOf(".");
        const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
        const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
        let n = 1; while (existingNames.has(`${base} (${n})${ext}`)) n++;
        const safe = `${base} (${n})${ext}`; existingNames.add(safe); return safe;
      };
      for (const f of items) {
        const tid = crypto.randomUUID();
        const dst = bottomRemotePath + "/" + getSafeName(f.name);
        addTransfer({ id: tid, name: `${f.path} → ${dst}`, direction: "upload", written: 0, total: 0, speed: 0, eta: 0, status: "waiting", srcPath: f.path, dstPath: dst, sessionId: bottomConn.sessionId });
        logActivity("upload", `${f.path} → ${dst}`);
        await new Promise(r => setTimeout(r, 500));
        if (f.is_dir) {
          invoke("sftp_upload_dir", { id: bottomConn.sessionId, localPath: f.path, remotePath: dst, transferId: tid })
            .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
        } else {
          invoke("sftp_upload", { id: bottomConn.sessionId, localPath: f.path, remotePath: dst, transferId: tid })
            .catch(() => setTransfers(prev => prev.map(t => t.id === tid ? { ...t, status: "error" } : t)));
        }
      }
      setRefreshKey(k => k + 1);
    }
  }, [activeId, remotePath, bottomConn, bottomRemotePath, addTransfer, logActivity]);

  /// Shared internal drop handler used by both HTML5 drop events and the
  /// pointer-drag fallback that bypasses WKWebView's blocked drop events.
  const handleInternalDroppedFiles = useCallback(async (targetPanel: "top" | "bottom", droppedFiles: any[]) => {
    if (!droppedFiles.length) return;
    const items: FileEntry[] = droppedFiles.map(f => ({ ...f } as FileEntry));
    const toDownload: FileEntry[] = [];
    const toUpload: FileEntry[] = [];
    const crossTB: FileEntry[] = [];
    const crossBT: FileEntry[] = [];

    for (const f of items) {
      const src: string = (f as any)._src || "";
      if (targetPanel === "top") {
        if (!activeId) continue;
        if (src === "local") {
          toUpload.push(f);
        } else if (src && bottomConn.type === "remote" && src === bottomConn.sessionId) {
          crossBT.push(f);
        }
      } else {
        if (src === activeId) {
          if (bottomConn.type === "remote") {
            crossTB.push(f);
          } else {
            toDownload.push(f);
          }
        } else if (src && bottomConn.type === "remote" && src === bottomConn.sessionId) {
          toDownload.push(f);
        }
      }
    }

    if (toUpload.length > 0) await handleBatchUpload(toUpload);
    if (toDownload.length > 0) await handleBatchDownload(toDownload);
    if (crossTB.length > 0) await handleTopCrossTransferBatch(crossTB);
    if (crossBT.length > 0) await handleBottomCrossTransferBatch(crossBT);

    (window as any).__weterm_pending_download = null;
    setRefreshKey(k => k + 1);
  }, [activeId, bottomConn, handleBatchUpload, handleBatchDownload, handleTopCrossTransferBatch, handleBottomCrossTransferBatch]);

  const handleDragOverZone = useCallback((zone: "top" | "bottom", e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (dragClearRef.current) { clearTimeout(dragClearRef.current); dragClearRef.current = null; }
    // WKWebView: getData may be restricted in drop events — capture payload during dragover
    let raw = "";
    try { raw = e.dataTransfer.getData("text/plain"); } catch { /* WKWebView may block getData */ }
    if (raw) {
      dragDataRef.current = raw;
      // Re-populate __weterm_drag from text/plain if it was cleared by dragleave
      if (!(window as any).__weterm_drag) {
        if (raw.startsWith("weterm-batch:")) {
          try { (window as any).__weterm_drag = JSON.parse(raw.slice(14)); } catch {}
        } else if (raw.startsWith("weterm:")) {
          try { (window as any).__weterm_drag = [JSON.parse(raw.slice(7))]; } catch {}
        }
      }
    }
    // Detect Finder drag-in: store URI list for drop handler
    let uriList = "";
    try { uriList = e.dataTransfer.getData("text/uri-list"); } catch { /* ignore */ }
    if (uriList) (window as any).__weterm_ext_uris = uriList;
    setDragOver(zone);
  }, []);

  const handleDragLeaveZone = useCallback(() => {
    dragClearRef.current = setTimeout(() => { setDragOver(null); dragDataRef.current = null; delete (window as any).__weterm_ext_uris; }, 150);
  }, []);

  // Tauri native file drop events: reliable Finder drag-in even when WKWebView
  // blocks HTML5 dataTransfer access.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const zoneFromPoint = (pos: { x: number; y: number }): "top" | "bottom" | null => {
      const x = pos.x / (window.devicePixelRatio || 1);
      const y = pos.y / (window.devicePixelRatio || 1);
      const el = document.elementFromPoint(x, y);
      const zone = el?.closest?.("[data-drop-zone]");
      const value = zone?.getAttribute("data-drop-zone");
      return value === "top" || value === "bottom" ? value : null;
    };

    getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        const zone = zoneFromPoint(p.position);
        if (zone) setDragOver(zone);
      } else if (p.type === "drop") {
        const zone = zoneFromPoint(p.position);
        setDragOver(null);
        if (zone && p.paths.length > 0) {
          uploadExternalPaths(zone, p.paths);
        }
      } else if (p.type === "leave") {
        setDragOver(null);
      }
    }).then(fn => { unlisten = fn; }).catch(() => {});

    return () => { unlisten?.(); };
  }, [uploadExternalPaths]);

  // Pointer-based in-app drag fallback. Tauri's native file-drop handler
  // intercepts drops while dragDropEnabled is true, which can suppress
  // WKWebView HTML5 drop events, so internal transfers use pointer events.
  useEffect(() => {
    let clickSuppressTimer: ReturnType<typeof setTimeout> | null = null;
    const markJustDragged = () => {
      (window as any).__weterm_just_dragged = true;
      if (clickSuppressTimer) clearTimeout(clickSuppressTimer);
      clickSuppressTimer = setTimeout(() => { (window as any).__weterm_just_dragged = false; }, 300);
    };
    const clearDrag = () => {
      (window as any).__weterm_custom_drag = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.documentElement.classList.remove("drag-active");
      setDragGhost(null);
      setDragOver(null);
    };
    const triggerDragOut = () => {
      const c = (window as any).__weterm_custom_drag;
      const pending = (window as any).__weterm_pending_download as any[] | undefined;
      if (c?.moved && pending?.length) {
        handleDragOutDownload(pending);
        (window as any).__weterm_pending_download = null;
      }
      clearDrag();
    };

    const onMove = (e: PointerEvent) => {
      const c = (window as any).__weterm_custom_drag;
      if (!c) return;
      if (!c.moved && Math.hypot(e.clientX - c.startX, e.clientY - c.startY) > 3) {
        c.moved = true;
      }
      if (c.moved) {
        e.preventDefault();
        markJustDragged();
        document.documentElement.classList.add("drag-active");
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const zone = el?.closest?.("[data-drop-zone]")?.getAttribute("data-drop-zone");
        setDragOver(zone === "top" || zone === "bottom" ? zone : null);
        const payload = (window as any).__weterm_drag as any[] | undefined;
        const label = payload?.length
          ? payload.length > 1 ? `${payload.length} items` : (payload[0]?.name || "item")
          : "Drag";
        setDragGhost({ x: e.clientX + 14, y: e.clientY + 14, label });

        // Leaving the window edge is the most reliable signal that the user is
        // trying to drag the remote file out to Finder.
        if (
          e.clientX <= 0 || e.clientY <= 0 ||
          e.clientX >= window.innerWidth - 1 || e.clientY >= window.innerHeight - 1
        ) {
          triggerDragOut();
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      const c = (window as any).__weterm_custom_drag;
      if (!c) return;
      if (c.moved) {
        markJustDragged();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const zone = el?.closest?.("[data-drop-zone]")?.getAttribute("data-drop-zone") as "top" | "bottom" | "terminal" | "notepad" | null;
        const payload = (window as any).__weterm_drag;
        if (zone && Array.isArray(payload) && payload.length) {
          if (zone === "terminal") {
            const first = payload[0] as FileEntry | undefined;
            if (first?.path) {
              terminalRef.current?.pasteText(first.path + " ");
            }
          } else if (zone === "notepad") {
            const el2 = document.querySelector(".notepad-wrap");
            if (el2) {
              el2.dispatchEvent(new CustomEvent("weterm-pointer-drop", { detail: payload }));
            }
          } else {
            handleInternalDroppedFiles(zone, payload);
          }
        }
      }
      clearDrag();
    };

    const onLeave = () => {
      const c = (window as any).__weterm_custom_drag;
      const pending = (window as any).__weterm_pending_download as any[] | undefined;
      if (c?.moved && pending?.length) {
        markJustDragged();
        handleDragOutDownload(pending);
        (window as any).__weterm_pending_download = null;
      }
      clearDrag();
    };
    const onDocMouseOut = (e: MouseEvent) => {
      if (!e.relatedTarget) triggerDragOut();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", triggerDragOut);
    document.addEventListener("pointercancel", triggerDragOut);
    document.addEventListener("mouseout", onDocMouseOut);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", triggerDragOut);
      document.removeEventListener("pointercancel", triggerDragOut);
      document.removeEventListener("mouseout", onDocMouseOut);
      if (clickSuppressTimer) clearTimeout(clickSuppressTimer);
    };
  }, [handleInternalDroppedFiles, handleDragOutDownload]);

  const handleDrop = useCallback(async (targetPanel: "top" | "bottom", e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);

    // ═══ Handle external file drops from macOS Finder ═══
    const extPaths = await resolveExternalPaths(e);
    if (extPaths.length > 0) {
      await uploadExternalPaths(targetPanel, extPaths);
      delete (window as any).__weterm_ext_uris;
      return;
    }

    // ═══ Handle internal Weterm drag-and-drop (between panels) ═══
    let raw = "";
    try { raw = e.dataTransfer.getData("text/plain"); } catch { /* WKWebView may block getData */ }
    raw = raw || dragDataRef.current || "";
    dragDataRef.current = null;
    delete (window as any).__weterm_ext_uris;
    if (!raw) return;

    // Parse drag payload — single file or batch
    let droppedFiles: any[] = [];
    if (raw.startsWith("weterm-batch:")) {
      try { droppedFiles = JSON.parse(raw.slice(14)); } catch { /* fall through */ }
    } else if (raw.startsWith("weterm:")) {
      try { droppedFiles = [JSON.parse(raw.slice(7))]; } catch { /* fall through */ }
    }
    if (!droppedFiles.length && (window as any).__weterm_drag) {
      droppedFiles = (window as any).__weterm_drag;
    }
    // Clean up window payload
    delete (window as any).__weterm_drag;
    if (!droppedFiles.length) return;

    await handleInternalDroppedFiles(targetPanel, droppedFiles);
  }, [resolveExternalPaths, uploadExternalPaths, handleInternalDroppedFiles]);

  const handleBatchDeleteRemote = useCallback(async (files: FileEntry[], sessionId: string) => {
    try {
      for (const f of files) {
        await invoke("sftp_delete", { id: sessionId, path: f.path });
      }
      setRefreshKey(k => k + 1);
    } catch (e) { showToast(String(e)); }
  }, []);

  const handleBatchDeleteLocal = useCallback(async (files: FileEntry[]) => {
    try {
      for (const f of files) {
        await invoke("local_delete", { path: f.path });
      }
      setRefreshKey(k => k + 1);
    } catch (e) { showToast(String(e)); }
  }, []);

  return (
    <div className="app">
      <TopBar
        sessions={Array.from(sessions.values()).filter(s => bottomConn.type !== "remote" || s.id !== bottomConn.sessionId)}
        tabNumbers={tabNumbers}
        activeId={activeId}
        prefillConn={prefillConn}
        history={history}
        onConnect={handleConnect}
        onSelect={setActiveId}
        onClose={handleDisconnect}
        onOpenSettings={() => setShowSettings(true)}
        onReconnect={handleReconnectSession}
        onReconnectSaved={handlePickerReconnect}
        onCloneTab={handleCloneTab}
        onDeleteConnection={handleDeleteConnection}
      />
      <div className="main-layout">
        <div className="sidebar" ref={sidebarRef} style={{ width: sidebarWidth }}>
          {/* ── Top panel (drives terminal) ── */}
          <div className="sidebar-section" style={remoteHeight !== null ? { flex: `0 0 ${remoteHeight}px` } : { flex: 1 }}>
            <div className="sidebar-section-header cp-header" title="Click to change connection" onClick={() => setPickerPanel("top")} style={{flexDirection:"column",alignItems:"stretch",gap:2,padding:"4px 8px"}}>
              <div className="cp-header-row1">
                <span className="cp-header-dot cp-dot-top" data-connected={!!activeSession} />
                <span className="cp-header-text-top">{activeSession ? `${activeSession.username}@${activeSession.host}` : "Remote (None)"}</span>
              </div>
              <div className="cp-header-row2" onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(activeSession ? remotePath : localPath); }}>
                {activeSession ? remotePath : localPath}
              </div>
            </div>
            <div
              className={`sidebar-body drop-zone ${dragOver === "top" ? "drag-over" : ""}`}
              data-drop-zone="top"
              onDragOver={e => handleDragOverZone("top", e)}
              onDragLeave={handleDragLeaveZone}
              onDrop={e => handleDrop("top", e)}
            >
              {activeSession ? (
                <FileBrowser type="remote" sessionId={activeSession.id} currentPath={remotePath} refreshKey={refreshKey} onNavigate={handleNavigate} onOpenFile={(s, p) => setEditor({ sessionId: s, path: p, name: p.split("/").pop() || p })} onDownload={handleContextDownload} onDelete={(f) => handleContextDelete(f, "remote")} onCopy={handleRemoteCopy} onPaste={handleRemotePaste} clipboardFile={remoteClipboard} onBatchDownload={handleBatchDownload} onBatchDelete={(files) => handleBatchDeleteRemote(files, activeSession.id)} crossTargetName={bottomConn.type === "remote" ? (() => { const s = sessions.get(bottomConn.sessionId); return s ? `${s.username}@${s.host}` : ""; })() : undefined} onTransferToRemote={handleTopCrossTransfer} onBatchTransferToRemote={handleTopCrossTransferBatch} onRename={(f) => handleRemoteRename(f)} onNewFolder={handleRemoteNewFolder} showFileMeta={settings.showFileMeta} showFilePermissions={settings.showFilePermissions} showFileOwner={settings.showFileOwner} showFileModified={settings.showFileModified} showFileSize={settings.showFileSize} />
              ) : (
                <div className="fb-empty">Click header to connect</div>
              )}
            </div>
          </div>

          <ResizeHandle direction="horizontal" onResize={handleRemoteResize} />

          {/* ── Bottom panel (independent connection) ── */}
          <div className="sidebar-section" style={{ flex: 1 }}>
            <div className="sidebar-section-header cp-header" title="Click to change connection" onClick={() => setPickerPanel("bottom")} style={{flexDirection:"column",alignItems:"stretch",gap:2,padding:"4px 8px"}}>
              <div className="cp-header-row1">
                <span className="cp-header-dot cp-dot-bottom" data-connected={bottomConn.type === "remote"} />
                <span className="cp-header-text-bottom">
                  {bottomConn.type === "remote"
                    ? (() => { const s = sessions.get(bottomConn.sessionId); return s ? `${s.username}@${s.host}` : "Remote (None)"; })()
                    : "Local Files"}
                </span>
              </div>
              <div className="cp-header-row2" onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(bottomConn.type === "remote" ? bottomRemotePath : bottomLocalPath); }}>
                {bottomConn.type === "remote" ? bottomRemotePath : bottomLocalPath}
              </div>
            </div>
            <div
              className={`sidebar-body drop-zone ${dragOver === "bottom" ? "drag-over" : ""}`}
              data-drop-zone="bottom"
              onDragOver={e => handleDragOverZone("bottom", e)}
              onDragLeave={handleDragLeaveZone}
              onDrop={e => handleDrop("bottom", e)}
            >
              {bottomConn.type === "remote" ? (
                <FileBrowser type="remote" sessionId={bottomConn.sessionId} currentPath={bottomRemotePath} refreshKey={refreshKey} onNavigate={(p) => {
                  setSessionStates(prev => {
                    const s = prev[bottomConn.sessionId];
                    if (!s) return prev;
                    return { ...prev, [bottomConn.sessionId]: { ...s, remotePath: p } };
                  });
                }} onOpenFile={(s, p) => setEditor({ sessionId: s, path: p, name: p.split("/").pop() || p })} onDownload={handleBottomContextDownload} onDelete={(f) => {
                  invoke("sftp_delete", { id: bottomConn.sessionId, path: f.path }).then(() => setRefreshKey(k => k + 1)).catch(e => showToast(String(e)));
                }} onBatchDownload={handleBottomBatchDownload} onBatchDelete={async (files) => {
                  for (const f of files) {
                    try { await invoke("sftp_delete", { id: bottomConn.sessionId, path: f.path }); } catch (e) { showToast(String(e)); return; }
                  }
                  setRefreshKey(k => k + 1);
                }} crossTargetName={activeSession ? `${activeSession.username}@${activeSession.host}` : undefined} onTransferToRemote={handleBottomCrossTransfer} onBatchTransferToRemote={handleBottomCrossTransferBatch} onRename={(f) => handleBottomRemoteRename(f)} onNewFolder={handleBottomRemoteNewFolder} showFileMeta={settings.showFileMeta} showFilePermissions={settings.showFilePermissions} showFileOwner={settings.showFileOwner} showFileModified={settings.showFileModified} showFileSize={settings.showFileSize} />
              ) : (
                <FileBrowser type="local" sessionId="" currentPath={bottomLocalPath} refreshKey={refreshKey} onNavigate={setBottomLocalPath} onUpload={handleContextUpload} onDelete={(f) => handleContextDelete(f, "local")} onBatchUpload={handleBatchUpload} onBatchDelete={handleBatchDeleteLocal} onRename={(f) => handleLocalRename(f)} onNewFolder={handleLocalNewFolder} showFileMeta={settings.showFileMeta} showFilePermissions={settings.showFilePermissions} showFileOwner={settings.showFileOwner} showFileModified={settings.showFileModified} showFileSize={settings.showFileSize} />
              )}
            </div>
          </div>
        </div>

        <ResizeHandle direction="vertical" onResize={handleSidebarResize} />

        <div className="main-area">
          {editor ? (
            <FileEditor sessionId={editor.sessionId} path={editor.path} fileName={editor.name} onClose={() => setEditor(null)} onSaved={() => setEditor(null)} />
          ) : activeSession ? (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div className="recording-bar">
                {recording && recording.sessionId === activeSession.id ? (
                  <>
                    <span className="rec-dot" />
                    <span className="rec-label">REC</span>
                    <span className="rec-time">{Math.floor((Date.now() - recording.startedAt) / 1000)}s</span>
                    <button className="btn btn-sm btn-danger rec-btn-start" onClick={stopRecording}>⏹ Stop</button>
                  </>
                ) : (
                  <>
                    <button className="btn btn-sm" onClick={startRecording} title="Start recording terminal session">⏺ Record</button>
                    <button className="btn btn-sm" onClick={() => setShowRecap(true)} title="View recordings">📼 Recap</button>
                  </>
                )}
              </div>
              <div style={{ flex: 1, overflow: "hidden" }}
                className={`term-drop-zone ${termDragOver ? "drag-over" : ""}`}
                data-drop-zone="terminal"
                onDragEnter={e => { e.preventDefault(); setTermDragOver(true); }}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
                onDragLeave={e => {
                  // Only clear if leaving the container itself (not children)
                  if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
                    setTermDragOver(false);
                  }
                }}
                onDrop={e => {
                  setTermDragOver(false);
                  e.preventDefault();
                  let raw = "";
                  try { raw = e.dataTransfer.getData("text/plain"); } catch { /* WKWebView may block getData */ }
                  raw = raw || (window as any).__weterm_drag?.raw || "";
                  let data: any = null;
                  if (raw?.startsWith("weterm:")) {
                    try { data = JSON.parse(raw.slice(7)); } catch {}
                  } else if (raw?.startsWith("weterm-batch:")) {
                    try { const arr = JSON.parse(raw.slice(14)); data = arr[0]; } catch {}
                  }
                  if (!data && (window as any).__weterm_drag) {
                    const d = (window as any).__weterm_drag;
                    data = Array.isArray(d) ? d[0] : d;
                  }
                  if (data?.path) {
                    terminalRef.current?.pasteText(data.path);
                  }
                }}
              >
                <SshTerminal key={activeSession.id} ref={terminalRef} session={activeSession} onCommand={handleCommand} fontSize={settings.terminalFontSize} fontFamily={settings.terminalFontFamily} onFontSizeChange={(size) => setSettings(prev => ({ ...prev, terminalFontSize: size }))} isRecording={!!recording && recording.sessionId === activeSession.id} onRecordingData={handleRecordingData} terminalBgColor={settings.terminalBgColor} terminalFgColor={settings.terminalFgColor} />
              </div>
            </div>
          ) : (
            <div className="welcome">
              <div className="welcome-brand">
                <img src="/weterm-blink.gif" alt="" className="welcome-logo" />
                <h1>Weterm</h1>
              </div>
              {history.length > 0 ? (
                <div className="welcome-history">
                  <div className="welcome-history-title">Recent Connections</div>
                  {history.slice(0, 6).map((conn, i) => (
                    <div
                      key={i}
                      className="welcome-history-item"
                      onDoubleClick={async () => {
                        try {
                          if (conn.authType === "password" && conn.hasKeychainSecret) {
                            const pw = await invoke<string>("keychain_get", { username: conn.username, host: conn.host });
                            await handleConnect({
                              id: crypto.randomUUID(),
                              name: `${conn.username}@${conn.host}:${conn.port}`,
                              host: conn.host,
                              port: conn.port,
                              username: conn.username,
                              authType: "password",
                              password: pw,
                            });
                          } else {
                            await handleConnect({
                              id: crypto.randomUUID(),
                              name: `${conn.username}@${conn.host}:${conn.port}`,
                              host: conn.host,
                              port: conn.port,
                              username: conn.username,
                              authType: conn.authType as any,
                              keyPath: conn.keyPath,
                            });
                          }
                        } catch (e) { showToast(String(e)); }
                      }}
                      title={`Double-click to connect to ${conn.username}@${conn.host}`}
                    >
                      <span className="wh-dot">●</span>
                      <span>{conn.username}@<b>{conn.host}</b>:{conn.port}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p>Click the top panel header (Remote) to connect</p>
              )}
            </div>
          )}
        </div>

        {activityLogWidth > 0 && (settings.showCommandsTab || settings.showTasksTab || settings.showNotepadTab) && (
          <ResizeHandle direction="vertical" onResize={handleActivityLogResize} />
        )}

        {(settings.showCommandsTab || settings.showTasksTab || settings.showNotepadTab) ? (
          <div className="right-panels" ref={rightPanelRef} style={{ width: activityLogWidth || 260 }}>
            {/* ── 1. Commands Panel (top) ── */}
            {settings.showCommandsTab && (
              <div style={commandLogHeight !== null ? { flex: `0 0 ${commandLogHeight}px`, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 } : { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
                <ActivityLog
                  key={activeId ?? "local"}
                  entries={activityEntries}
                  width={activityLogWidth || 260}
                  maxDisplay={settings.maxDisplayEntries}
                  onDoubleClickEntry={handleActivityDoubleClick}
                  customCommands={customCommands}
                  onAddCustomCommand={handleAddCustomCommand}
                  onDeleteCustomCommand={handleDeleteCustomCommand}
                  onDoubleClickCustomCommand={handleDoubleClickCustomCommand}
                />
              </div>
            )}

            {settings.showCommandsTab && settings.showTasksTab && (
              <ResizeHandle direction="horizontal" onResize={handleCommandLogResize} />
            )}

            {/* ── 2. Tasks Panel (middle) — with history toggle ── */}
            {settings.showTasksTab && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
                <TaskPanel
                  transfers={sessionTransfers}
                  transferHistory={activeTransferHistory}
                  onCancel={cancelTransfer}
                  onDoubleClick={handleActivityDoubleClick}
                  width={activityLogWidth || 260}
                  maxDisplay={settings.maxDisplayEntries}
                />
              </div>
            )}

            {settings.showTasksTab && settings.showNotepadTab && (
              <ResizeHandle direction="horizontal" onResize={handleNotepadResize} />
            )}

            {/* ── 3. Monitor Panel (DISABLED — perf) ── */}
            {/* {settings.showTasksTab && settings.showMonitorTab && (
              <ResizeHandle direction="horizontal" onResize={handleMonitorResize} />
            )}
            {settings.showMonitorTab && (
              <div style={monitorHeight !== null ? { flex: `0 0 ${monitorHeight}px`, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 } : { flex: "0 0 200px", display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
                <MonitorPanel
                  isRemote={!!activeSession}
                  sessionId={activeId}
                  width={activityLogWidth || 260}
                />
              </div>
            )}
            {settings.showMonitorTab && settings.showNotepadTab && (
              <ResizeHandle direction="horizontal" onResize={handleNotepadResize} />
            )} */}

            {/* ── 3. Notepad (bottom) ── */}
            {settings.showNotepadTab && (
              <Notepad savePath={settings.notepadSavePath} height={notepadHeight ?? undefined} fontFamily={settings.notepadFontFamily} fontSize={settings.notepadFontSize} />
            )}
          </div>
        ) : null}
      </div>
      <BottomBar
        statusInfo={statusInfo}
        isConnected={!!activeSession}
        showCpu={settings.showCpu}
        showMem={settings.showMem}
        showLoginTime={settings.showLoginTime}
        showDuration={settings.showDuration}
        statusStyle={settings.statusStyle}
      />
      <ToastHost />
      {dragGhost && (
        <div className="drag-ghost" style={{ left: dragGhost.x, top: dragGhost.y }}>
          {dragGhost.label}
        </div>
      )}
      {showSettings && (
        <SettingsModal
          settings={settings}
          onUpdate={handleSaveSettings}
          onClose={() => setShowSettings(false)}
          onResetDefaults={handleResetDefaults}
        />
      )}
      {conflict && (
        <ConfirmReplaceModal
          fileName={conflict.fileName}
          copyName={conflict.copyName}
          onReplace={conflict.onReplace}
          onRename={conflict.onRename}
          onCancel={conflict.onCancel}
        />
      )}
      {pickerPanel && (
        <ConnectionPickerModal
          title={pickerPanel === "top" ? "Top Panel — Connect" : "Bottom Panel — Connect"}
          history={history}
          onConnect={handlePickerConnect}
          onReconnect={handlePickerReconnect}
          onUpdateConnection={handleUpdateConnection}
          onDeleteConnection={handleDeleteConnection}
          onLocal={handlePickerLocal}
          onClose={() => setPickerPanel(null)}
          allowLocal={pickerPanel !== "top"}
        />
      )}
      {namePrompt && (
        <NamePromptModal
          title={namePrompt.title}
          label={namePrompt.label}
          initialValue={namePrompt.initialValue}
          onSubmit={namePrompt.onSubmit}
          onClose={() => setNamePrompt(null)}
        />
      )}
      {showRecap && (
        <Suspense fallback={null}>
          <RecapPanel onClose={() => setShowRecap(false)} />
        </Suspense>
      )}
    </div>
  );
}
