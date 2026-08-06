import { useState, memo, useSyncExternalStore, useCallback } from "react";
import type { TransferItem } from "../App";
import type { ActivityEntry } from "../types";
import { progressStore } from "../progressStore";

interface Props {
  transfers: TransferItem[];
  transferHistory: ActivityEntry[];
  onCancel: (id: string) => void;
  onDoubleClick?: (entry: ActivityEntry) => void;
  width: number;
  maxDisplay: number;
}

function fmt(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

function speedFmt(s: number): string {
  if (s < 1024) return `${s.toFixed(0)}B/s`;
  if (s < 1048576) return `${(s / 1024).toFixed(0)}KB/s`;
  return `${(s / 1048576).toFixed(1)}MB/s`;
}

function etaFmt(s: number): string {
  if (s <= 0) return "--";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h`;
}

function taskFileName(t: TransferItem): string {
  const path = t.direction === "download" ? t.srcPath : t.dstPath;
  if (path) return path.split("/").pop() || (t.name ?? "?");
  return (t.name ?? "?").split("/").pop()?.split(" →")[0] || (t.name ?? "?");
}

function taskPathDesc(t: TransferItem): string {
  if (t.srcPath && t.dstPath) return `${t.srcPath} → ${t.dstPath}`;
  return t.name ?? "?";
}

export default memo(function TaskPanel({ transfers, transferHistory, onCancel, onDoubleClick, width, maxDisplay }: Props) {
  const collapsed = width === 0;
  const [showHistory, setShowHistory] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Subscribe to live progress data — this re-renders TaskPanel only,
  // not the entire App tree. React state (App.tsx) is only touched for
  // structural changes (add / status transition / remove).
  // NOTE: subscribe/getSnapshot must be STABLE references — .bind() creates
  // a new function on every render which breaks useSyncExternalStore.
  const subscribe = useCallback((cb: () => void) => progressStore.subscribe(cb), []);
  const getSnapshot = useCallback(() => progressStore.getSnapshot(), []);
  const liveProgress = useSyncExternalStore(subscribe, getSnapshot);

  const q = searchQuery.trim().toLowerCase();
  const filterBySearch = (t: TransferItem) => !q || taskFileName(t).toLowerCase().includes(q) || taskPathDesc(t).toLowerCase().includes(q);
  const waitingTransfers = transfers.filter(t => t.status === "waiting" && filterBySearch(t));
  const activeTransfers = transfers.filter(t => t.status === "transferring" && filterBySearch(t));
  // Show newest completed first (reverse order since array is oldest-first)
  const recentTransfers = transfers
    .filter(t => t.status !== "transferring" && t.status !== "waiting" && filterBySearch(t))
    .slice()
    .reverse();

  // Merge live progress into a transfer item so render code can stay the same
  const mergeProgress = (t: TransferItem): TransferItem => {
    const live = liveProgress[t.id];
    if (live && (live.written > 0 || live.total > 0)) {
      return { ...t, written: live.written, total: live.total, speed: live.speed, eta: live.eta };
    }
    return t;
  };

  const arrow = (t: TransferItem) => {
    const hasCross = t.crossDir;
    if (hasCross === "to-top") return <span className="tp-arrow tp-arrow-red">↑</span>;
    if (hasCross === "to-bottom") return <span className="tp-arrow tp-arrow-blue">↑</span>;
    if (t.direction === "upload") return <span className="tp-arrow tp-arrow-up">↑</span>;
    return <span className="tp-arrow tp-arrow-down">↓</span>;
  };

  const historyIcon = (entry: ActivityEntry) => {
    if (entry.type === "upload") return <span className="tp-arrow tp-arrow-up">↑</span>;
    return <span className="tp-arrow tp-arrow-down">↓</span>;
  };

  // Group history by day, with search filter
  const filteredHistory = q
    ? transferHistory.filter(e => e.detail.toLowerCase().includes(q))
    : transferHistory;
  const limitedHistory = filteredHistory.slice(0, maxDisplay);
  const groups: { label: string; entries: typeof limitedHistory }[] = [];
  let currentLabel = "";
  for (const e of limitedHistory) {
    const d = new Date(e.timestamp);
    const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ label, entries: [] });
    }
    groups[groups.length - 1].entries.push(e);
  }

  return (
    <div className="task-panel" style={{ width, minWidth: collapsed ? 0 : 160 }}>
      <div className="tp-header">
        <span className="tp-title">Tasks</span>
        <div className="tp-header-actions">
          <button
            className="tp-toggle-btn"
            onClick={() => setShowHistory(!showHistory)}
            title={showHistory ? "Show active tasks" : "Show transfer history"}
          >{showHistory ? "Tasks" : "History"}</button>
        </div>
      </div>

      {!collapsed && (
        <div className="tp-body">
          {/* Search filter */}
          <div className="fb-search">
            <input
              className="fb-search-input"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") setSearchQuery(""); }}
            />
          </div>
          {showHistory ? (
            /* ── Transfer History View (overlays task area) ── */
            groups.length === 0 ? (
              <div className="tp-empty">No transfer history</div>
            ) : (
              groups.map((g, gi) => (
                <div key={gi}>
                  <div className="tp-day-sep">{g.label}</div>
                  {g.entries.map(entry => (
                    <div
                      key={entry.id}
                      className="tp-history-item"
                      onDoubleClick={() => onDoubleClick?.(entry)}
                      title="Double-click to insert SCP command"
                    >
                      {historyIcon(entry)}
                      <span className="tp-history-time">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="tp-history-detail">{entry.detail}</span>
                    </div>
                  ))}
                </div>
              ))
            )
          ) : (
            /* ── Active Tasks View ── */
            <>
              {/* ACTIVE first — currently executing */}
              {activeTransfers.length > 0 && (
                <div className="tp-section">
                  <div className="tp-section-header">ACTIVE ({activeTransfers.length})</div>
                  {activeTransfers.map((t, i) => {
                    const mt = mergeProgress(t);
                    return (
                    <div key={mt.id} className="tp-task-item active">
                      <div className="tp-task-row1">
                        <span className="tp-task-idx">{i + 1}</span>
                        {arrow(mt)}
                        <span className="tp-task-name" title={taskPathDesc(mt)}>{taskFileName(mt)}</span>
                        <button className="tp-cancel" onClick={() => onCancel(mt.id)} title="Cancel">✕</button>
                      </div>
                      <div className="tp-task-path" title={taskPathDesc(mt)}>{taskPathDesc(mt)}</div>
                      <div className="tp-task-row2">
                        {mt.total > 0 ? (
                          <>
                            <div className="tp-progress-bar">
                              <div className="tp-progress-fill" style={{ width: `${Math.min(100, (mt.written / mt.total) * 100)}%` }} />
                            </div>
                            <span className="tp-progress-text">{fmt(mt.written)}/{fmt(mt.total)}</span>
                          </>
                        ) : (
                          <span className="tp-starting">Starting…</span>
                        )}
                      </div>
                      {mt.total > 0 && (
                        <div className="tp-task-row3">
                          <span className="tp-speed">{speedFmt(mt.speed)}</span>
                          <span className="tp-eta">{etaFmt(mt.eta)}</span>
                          {mt.crossDir && <span className="tp-cross-badge">{mt.direction === "download" ? "↓ 1/2" : "↑ 2/2"}</span>}
                        </div>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}

              {/* WAITING second — queued up next */}
              {waitingTransfers.length > 0 && (
                <div className="tp-section">
                  <div className="tp-section-header">WAITING ({waitingTransfers.length})</div>
                  {waitingTransfers.map((t, i) => (
                    <div key={t.id} className="tp-task-item waiting">
                      <div className="tp-task-row1">
                        <span className="tp-task-idx">{activeTransfers.length + i + 1}</span>
                        {arrow(t)}
                        <span className="tp-task-name" title={taskPathDesc(t)}>{taskFileName(t)}</span>
                        <button className="tp-cancel" onClick={() => onCancel(t.id)} title="Cancel">✕</button>
                      </div>
                      <div className="tp-task-path" title={taskPathDesc(t)}>{taskPathDesc(t)}</div>
                      <div className="tp-task-row2">
                        <span className="tp-starting">Waiting for slot...</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {recentTransfers.length > 0 && (
                <div className="tp-section">
                  <div className="tp-section-header">RECENT</div>
                  {recentTransfers.map((t, i) => {
                    const mt = mergeProgress(t);
                    return (
                    <div key={mt.id} className={`tp-task-item ${mt.status}`}>
                      <div className="tp-task-row1">
                        <span className="tp-task-idx">{activeTransfers.length + waitingTransfers.length + i + 1}</span>
                        {arrow(mt)}
                        <span className="tp-task-name" title={taskPathDesc(mt)}>{taskFileName(mt)}</span>
                        <span className={`tp-status-badge tp-status-${mt.status}`}>
                          {mt.status === "done" ? "✓" : mt.status === "error" ? "✗" : "⊘"}
                        </span>
                      </div>
                      <div className="tp-task-path" title={taskPathDesc(mt)}>{taskPathDesc(mt)}</div>
                      <div className="tp-task-row2">
                        <span className="tp-progress-text">{mt.total > 0 ? `${fmt(mt.written)}/${fmt(mt.total)}` : "—"}</span>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}

              {waitingTransfers.length === 0 && activeTransfers.length === 0 && recentTransfers.length === 0 && (
                <div className="tp-empty">No tasks yet</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
