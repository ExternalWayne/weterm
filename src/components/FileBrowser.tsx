import { useState, useEffect, useCallback, useRef, memo, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../types";

// Cached size display string — avoid allocating on every render
function sz(s: number): string {
  if (s < 1024) return `${s}B`;
  if (s < 1048576) return `${(s/1024).toFixed(0)}KB`;
  if (s < 1073741824) return `${(s/1048576).toFixed(1)}MB`;
  return `${(s/1073741824).toFixed(1)}GB`;
}

// Pre-compute display size once per file entry (avoids per-render allocation)
interface FileEntryDisplay extends FileEntry {
  _sizeDisp: string;
}

function addDisplayFields(entry: FileEntry): FileEntryDisplay {
  return { ...entry, _sizeDisp: entry.is_dir ? "" : sz(entry.size) };
}

// ── Memoized FileRow — skips re-render when selection state unchanged ──
interface FileRowProps {
  f: FileEntryDisplay;
  isSelected: boolean;
  showPerms: boolean;
  showOwner: boolean;
  showModified: boolean;
  showSize: boolean;
  onRowClick: (e: React.MouseEvent, path: string) => void;
  onRowDblClick: (path: string) => void;
  onCheckClick: (e: React.MouseEvent, path: string) => void;
  onRowCtxMenu: (e: React.MouseEvent, path: string) => void;
  onRowMouseDown: (e: React.PointerEvent, path: string) => void;
}

const FileRow = memo(function FileRow({
  f, isSelected, showPerms, showOwner, showModified, showSize,
  onRowClick, onRowDblClick, onCheckClick, onRowCtxMenu, onRowMouseDown,
}: FileRowProps) {
  return (
    <div
      className={`fb-row${isSelected ? " selected" : ""}`}
      onClick={e => onRowClick(e, f.path)}
      onPointerDown={e => onRowMouseDown(e, f.path)}
      onDoubleClick={() => onRowDblClick(f.path)}
      title={`${f.is_dir ? "Folder" : "File"}: ${f.path}${f._sizeDisp ? ` — ${f._sizeDisp}` : ""}`}
      onContextMenu={e => onRowCtxMenu(e, f.path)}
    >
      <span className="fb-check-cell" onClick={e => onCheckClick(e, f.path)}>
        <span className={`fb-check${isSelected ? " checked" : ""}`}>
          {isSelected ? "✓" : ""}
        </span>
      </span>
      <span className="fb-n" title={f.name}><span className={`ico ${f.is_dir ? "ico-d" : "ico-f"}`} />{f.name}</span>
      {showPerms && <span className="fb-p">{f.permissions}</span>}
      {showOwner && <span className="fb-o">{f.owner}</span>}
      {showModified && <span className="fb-m">{f.modified}</span>}
      {showSize && <span className="fb-s">{f._sizeDisp}</span>}
    </div>
  );
});

interface Props {
  type: "remote" | "local";
  sessionId: string;
  currentPath: string;
  refreshKey: number;
  onNavigate: (p: string) => void;
  onOpenFile?: (sid: string, p: string) => void;
  // Single-item actions (handles both files and dirs internally)
  onUpload?: (file: FileEntry) => void;
  onDownload?: (file: FileEntry) => void;
  onDelete?: (file: FileEntry) => void;
  onCopy?: (file: FileEntry) => void;
  onPaste?: () => void;
  clipboardFile?: { path: string; name: string } | null;
  // Batch actions (handles mixed files+dirs internally)
  onBatchDownload?: (files: FileEntry[]) => void;
  onBatchUpload?: (files: FileEntry[]) => void;
  onBatchDelete?: (files: FileEntry[]) => void;
  // Cross-server transfer (this remote → another remote)
  crossTargetName?: string;
  onTransferToRemote?: (file: FileEntry) => void;
  onBatchTransferToRemote?: (files: FileEntry[]) => void;
  // Rename & new folder
  onRename?: (file: FileEntry) => void;
  onNewFolder?: () => void;
  // Display settings
  showFileMeta?: boolean;
  showFilePermissions?: boolean;
  showFileOwner?: boolean;
  showFileModified?: boolean;
  showFileSize?: boolean;
}

interface CtxMenu {
  x: number; y: number; file: FileEntry;
}

export default memo(function FileBrowser({ type, sessionId, currentPath, refreshKey, onNavigate, onOpenFile, onUpload, onDownload, onDelete, onCopy, onPaste, clipboardFile, onBatchDownload, onBatchUpload, onBatchDelete, crossTargetName, onTransferToRemote, onBatchTransferToRemote, onRename, onNewFolder, showFilePermissions, showFileOwner, showFileModified, showFileSize }: Props) {
  const [files, setFiles] = useState<FileEntryDisplay[]>([]);
  const [loading, setLoading] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);
  const [internalRefresh, setInternalRefresh] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const lastClickedRef = useRef<string | null>(null);
  // Refs for stable callbacks (so memoized FileRow doesn't re-render on parent state changes)
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const filesRef = useRef(files);
  filesRef.current = files;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = type === "remote"
        ? await invoke<FileEntry[]>("sftp_list_files", { id: sessionId, path: currentPath })
        : await invoke<FileEntry[]>("local_list_files", { path: currentPath });
      setFiles(r.map(addDisplayFields));
    } catch { setFiles([]); }
    setLoading(false);
  }, [type, sessionId, currentPath]);

  useEffect(() => { if (type === "remote" && !sessionId) return; load(); }, [type, sessionId, currentPath, refreshKey, internalRefresh, load]);

  // Clear selection when path changes or file list refreshes (transfers, etc.)
  useEffect(() => { setSelected(new Set()); lastClickedRef.current = null; }, [currentPath, refreshKey]);

  // Close context menus on outside click or Escape
  useEffect(() => {
    if (!ctxMenu && !emptyMenu) return;
    const close = () => { setCtxMenu(null); setEmptyMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", onKey); };
  }, [ctxMenu, emptyMenu]);

  const up = () => {
    // Remove trailing slashes
    const clean = currentPath.replace(/\/+$/, "") || "/";
    // At root: nowhere to go
    if (clean === "/" || clean === "~") return;
    // Find parent via last slash
    const lastSlash = clean.lastIndexOf("/");
    if (lastSlash < 0) {
      // No slash in path (shouldn't happen for absolute paths, but be safe)
      onNavigate("/");
      return;
    }
    if (lastSlash === 0) {
      // Parent is root (e.g., /Users → /)
      onNavigate("/");
      return;
    }
    // ~/foo/bar → ~/foo  OR  /a/b/c → /a/b
    const parent = clean.slice(0, lastSlash);
    onNavigate(parent || "/");
  };

  // Drag support is now in handleDragStart (stable callback)

  // ── Multi-select click handling (stable callbacks via refs — avoids re-rendering all FileRows) ──

  const handleRowClick = useCallback((e: React.MouseEvent, path: string) => {
    if (consumeDragClick()) return;
    if ((e.target as HTMLElement).closest('.fb-check')) return;
    const curFiles = filesRef.current;
    const f = curFiles.find(x => x.path === path);
    if (!f) return;
    if (e.ctrlKey || e.metaKey) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      lastClickedRef.current = path;
    } else if (e.shiftKey && lastClickedRef.current) {
      const start = curFiles.findIndex(x => x.path === lastClickedRef.current);
      const end = curFiles.findIndex(x => x.path === path);
      if (start >= 0 && end >= 0) {
        const [lo, hi] = start < end ? [start, end] : [end, start];
        const range = new Set<string>();
        for (let i = lo; i <= hi; i++) range.add(curFiles[i].path);
        setSelected(range);
      }
    } else {
      setSelected(new Set([path]));
      lastClickedRef.current = path;
    }
  }, []);

  const handleCheckClick = useCallback((_e: React.MouseEvent, path: string) => {
    if (consumeDragClick()) return;
    _e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    lastClickedRef.current = path;
  }, []);

  const handleRowDblClick = useCallback((path: string) => {
    if (consumeDragClick()) return;
    const curFiles = filesRef.current;
    const f = curFiles.find(x => x.path === path);
    if (!f) return;
    if (f.is_dir) onNavigate(f.path);
    else if (type === "remote" && onOpenFile) onOpenFile(sessionId, f.path);
  }, [type, sessionId, onNavigate, onOpenFile]);

  // Prepare an internal pointer-drag payload. This path does not depend on
  // WKWebView HTML5 drop events, which are intercepted by Tauri's native
  // file-drop handler while it is enabled for Finder drag-in.
  const handleRowMouseDown = useCallback((e: React.PointerEvent, path: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.fb-check')) return;
    // Prevent native text selection while the pointer drag may start.
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    const curFiles = filesRef.current;
    const sel = selectedRef.current;
    let payload: any[];
    if (sel.size > 1 && sel.has(path)) {
      const selectedFiles = curFiles.filter(ff => sel.has(ff.path));
      payload = selectedFiles.map(ff => ({ ...ff, _src: type === "remote" ? sessionId : "local" }));
    } else {
      const f = curFiles.find(x => x.path === path);
      if (!f) return;
      payload = [{ ...f, _src: type === "remote" ? sessionId : "local" }];
    }
    (window as any).__weterm_drag = payload;
    (window as any).__weterm_custom_drag = { startX: e.clientX, startY: e.clientY, moved: false };
    if (type === "remote") {
      (window as any).__weterm_pending_download = payload;
    }
  }, [type, sessionId]);

  const consumeDragClick = useCallback((): boolean => {
    if ((window as any).__weterm_just_dragged) {
      (window as any).__weterm_just_dragged = false;
      return true;
    }
    return false;
  }, []);

  const handleRowCtxMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    const curFiles = filesRef.current;
    const f = curFiles.find(x => x.path === path);
    if (!f) return;
    if (!selectedRef.current.has(path)) {
      setSelected(new Set([path]));
      lastClickedRef.current = path;
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, file: f });
  }, []);

  const handleBodyClick = useCallback((e: React.MouseEvent) => {
    if (consumeDragClick()) return;
    if (!(e.target as HTMLElement).closest('.fb-row')) {
      setSelected(new Set());
      lastClickedRef.current = null;
    }
  }, []);

  // ── Filter files by search query ──
  const filteredFiles = searchQuery.trim()
    ? files.filter(f => f.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : files;

  // ── Batch operations (memoized to avoid O(n) filter on every render) ──
  const selectedFiles = useMemo(() => files.filter(f => selected.has(f.path)), [files, selected]);

  if (loading) return <div className="fb-loading">Loading...</div>;

  return (
    <div className="fb">
      <div className="fb-hdr">
        <span className="fb-check-hdr" onClick={() => {
          // Select-all toggle: if all filtered are selected, deselect; otherwise select all
          const allSelected = filteredFiles.length > 0 && filteredFiles.every(f => selected.has(f.path));
          if (allSelected) {
            setSelected(new Set());
          } else {
            setSelected(new Set(filteredFiles.map(f => f.path)));
          }
          lastClickedRef.current = null;
        }} title={filteredFiles.length > 0 && filteredFiles.every(f => selected.has(f.path)) ? "Deselect all" : "Select all"}>
          <span className={`fb-check fb-check-all${filteredFiles.length > 0 && filteredFiles.every(f => selected.has(f.path)) ? " checked" : ""}${filteredFiles.length > 0 && !filteredFiles.every(f => selected.has(f.path)) && filteredFiles.some(f => selected.has(f.path)) ? " partial" : ""}`}>
            {filteredFiles.length > 0 && filteredFiles.every(f => selected.has(f.path)) ? "✓" : filteredFiles.some(f => selected.has(f.path)) ? "−" : ""}
          </span>
        </span>
        <span className="fb-n">Name</span>
        {showFilePermissions && <span className="fb-p">Perms</span>}
        {showFileOwner && <span className="fb-o">Owner</span>}
        {showFileModified && <span className="fb-m">Modified</span>}
        {showFileSize && <span className="fb-s">Size</span>}
      </div>
      {/* Search filter */}
      <div className="fb-search">
        <input
          className="fb-search-input"
          placeholder="Filter files..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") setSearchQuery(""); }}
        />
      </div>
      <div className="fb-body" onClick={handleBodyClick} onContextMenu={e => {
        if ((e.target as HTMLElement).closest('.fb-row')) return;
        e.preventDefault();
        setEmptyMenu({ x: e.clientX, y: e.clientY });
      }}>
        {currentPath !== "/" && (
          <div className="fb-row" onDoubleClick={up} title="Go to parent directory">
            <span className="fb-check-cell" />
            <span className="fb-n"><span className="ico ico-d" />..</span>
            {showFilePermissions && <span className="fb-p" />}
            {showFileOwner && <span className="fb-o" />}
            {showFileModified && <span className="fb-m" />}
            {showFileSize && <span className="fb-s" />}
          </div>
        )}
        {filteredFiles.map(f => (
          <FileRow
            key={f.path}
            f={f}
            isSelected={selected.has(f.path)}
            showPerms={!!showFilePermissions}
            showOwner={!!showFileOwner}
            showModified={!!showFileModified}
            showSize={!!showFileSize}
            onRowClick={handleRowClick}
            onRowDblClick={handleRowDblClick}
            onCheckClick={handleCheckClick}
            onRowCtxMenu={handleRowCtxMenu}
            onRowMouseDown={handleRowMouseDown}
          />
        ))}
        {!filteredFiles.length && !loading && <div className="fb-empty">{searchQuery ? "No matches" : "Empty"}</div>}
      </div>

      {/* Batch action bar */}
      {selected.size > 0 && (
        <div className="fb-batch-bar">
          <span className="fb-batch-info">{selected.size} selected</span>
          <div className="fb-batch-actions">
            {type === "remote" && onBatchDownload && (
              <button className="btn btn-sm" onClick={() => { onBatchDownload(selectedFiles); setSelected(new Set()); }} title="Download selected items to local machine">
                ↓ Download ({selected.size})
              </button>
            )}
            {type === "remote" && crossTargetName && onBatchTransferToRemote && (
              <button className="btn btn-sm" onClick={() => { onBatchTransferToRemote(selectedFiles); setSelected(new Set()); }} title={`Transfer selected items to ${crossTargetName}`}>
                → Transfer to {crossTargetName} ({selected.size})
              </button>
            )}
            {type === "local" && onBatchUpload && (
              <button className="btn btn-sm" onClick={() => { onBatchUpload(selectedFiles); setSelected(new Set()); }} title="Upload selected items to remote server">
                ↑ Upload ({selected.size})
              </button>
            )}
            <button className="btn btn-sm btn-danger" onClick={() => { onBatchDelete?.(selectedFiles); setSelected(new Set()); }} title="Delete selected items">
              ✕ Delete
            </button>
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && (
        <div className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          {selected.size > 1 ? (
            <>
              <div className="cm-item cm-batch-label">— {selected.size} selected —</div>
              {type === "remote" && onBatchDownload && (
                <div className="cm-item" onClick={() => { onBatchDownload(selectedFiles); setCtxMenu(null); setSelected(new Set()); }} title="Download selected items to local machine">
                  <span className="cm-icon">⤓</span>Download {selected.size} item(s)
                </div>
              )}
              {type === "remote" && crossTargetName && onBatchTransferToRemote && (
                <div className="cm-item" onClick={() => { onBatchTransferToRemote(selectedFiles); setCtxMenu(null); setSelected(new Set()); }} title={`Transfer to ${crossTargetName}`}>
                  <span className="cm-icon">⇉</span>Transfer {selected.size} item(s)
                </div>
              )}
              {type === "local" && onBatchUpload && (
                <div className="cm-item" onClick={() => { onBatchUpload(selectedFiles); setCtxMenu(null); setSelected(new Set()); }} title="Upload selected items to remote server">
                  <span className="cm-icon">⤒</span>Upload {selected.size} item(s)
                </div>
              )}
              <div className="cm-item" onClick={() => {
                const paths = selectedFiles.map(f => f.path).join('\n');
                navigator.clipboard.writeText(paths);
                setCtxMenu(null); setSelected(new Set());
              }} title="Copy selected file paths">
                <span className="cm-icon">⧉</span>Copy Paths
              </div>
              <div className="cm-sep" />
              <div className="cm-item danger" onClick={() => { onBatchDelete?.(selectedFiles); setCtxMenu(null); setSelected(new Set()); }} title="Delete selected items">
                <span className="cm-icon">⨯</span>Delete {selected.size} item(s)
              </div>
            </>
          ) : (
            <>
              {type === "remote" ? (
                <>
                  {onDownload && (
                    <div className="cm-item" onClick={() => { onDownload(ctxMenu.file); setCtxMenu(null); }} title="Download to local machine">
                      <span className="cm-icon">⤓</span>Download
                    </div>
                  )}
                  {crossTargetName && onTransferToRemote && (
                    <div className="cm-item" onClick={() => { onTransferToRemote(ctxMenu.file); setCtxMenu(null); }} title={`Transfer to ${crossTargetName}`}>
                      <span className="cm-icon">⇉</span>Transfer to {crossTargetName}
                    </div>
                  )}
                  {!ctxMenu.file.is_dir && onOpenFile && (
                    <div className="cm-item" onClick={() => { onOpenFile(sessionId, ctxMenu.file.path); setCtxMenu(null); }} title="Open in text editor">
                      <span className="cm-icon">✐</span>Edit
                    </div>
                  )}
                  <div className="cm-item" onClick={() => {
                    navigator.clipboard.writeText(ctxMenu.file.path);
                    setCtxMenu(null);
                  }} title="Copy full path to clipboard">
                    <span className="cm-icon">⧉</span>Copy Path
                  </div>
                  <div className="cm-item" onClick={() => { onCopy?.(ctxMenu.file); setCtxMenu(null); }} title="Copy file to clipboard (for paste within Weterm)">
                    <span className="cm-icon">⎘</span>Copy File
                  </div>
                  {clipboardFile && (
                    <div className="cm-item" onClick={() => { onPaste?.(); setCtxMenu(null); }} title={`Paste "${clipboardFile.name}" into current directory`}>
                      <span className="cm-icon">⎙</span>Paste "{clipboardFile.name}"
                    </div>
                  )}
                  <div className="cm-sep" />
                  <div className="cm-item" onClick={() => { onRename?.(ctxMenu.file); setCtxMenu(null); }} title="Rename this item">
                    <span className="cm-icon">✐</span>Rename
                  </div>
                  <div className="cm-item danger" onClick={() => { onDelete?.(ctxMenu.file); setCtxMenu(null); }} title="Delete this item">
                    <span className="cm-icon">⨯</span>Delete
                  </div>
                </>
              ) : (
                <>
                  {onUpload && (
                    <div className="cm-item" onClick={() => { onUpload(ctxMenu.file); setCtxMenu(null); }} title="Upload to connected remote server">
                      <span className="cm-icon">⤒</span>Upload to Remote
                    </div>
                  )}
                  <div className="cm-item" onClick={() => {
                    navigator.clipboard.writeText(ctxMenu.file.path);
                    setCtxMenu(null);
                  }} title="Copy full path to clipboard">
                    <span className="cm-icon">⧉</span>Copy Path
                  </div>
                  <div className="cm-item" onClick={() => { onCopy?.(ctxMenu.file); setCtxMenu(null); }} title="Copy file to clipboard (for paste within Weterm)">
                    <span className="cm-icon">⎘</span>Copy File
                  </div>
                  <div className="cm-sep" />
                  <div className="cm-item" onClick={() => { onRename?.(ctxMenu.file); setCtxMenu(null); }} title="Rename this item">
                    <span className="cm-icon">✐</span>Rename
                  </div>
                  <div className="cm-item danger" onClick={() => { onDelete?.(ctxMenu.file); setCtxMenu(null); }} title="Delete this item">
                    <span className="cm-icon">⨯</span>Delete
                  </div>
                </>
              )}
            </>
          )}
          <div className="cm-sep" />
          <div className="cm-item" onClick={() => { setInternalRefresh(k => k + 1); setCtxMenu(null); }} title="Refresh file list">
            <span className="cm-icon">⟳</span>Refresh
          </div>
        </div>
      )}

      {/* Empty-space right-click menu */}
      {emptyMenu && (
        <div className="context-menu" style={{ left: emptyMenu.x, top: emptyMenu.y }}>
          <div className="cm-item" onClick={() => { onNewFolder?.(); setEmptyMenu(null); }} title="Create a new folder">
            <span className="cm-icon">⊕</span>New Folder
          </div>
          <div className="cm-item" onClick={() => {
            navigator.clipboard.writeText(currentPath);
            setEmptyMenu(null);
          }} title="Copy current directory path">
            <span className="cm-icon">⧉</span>Copy Folder Path
          </div>
          <div className="cm-sep" />
          <div className="cm-item" onClick={() => { onNavigate(currentPath); setEmptyMenu(null); }} title="Refresh file list">
            <span className="cm-icon">⟳</span>Refresh
          </div>
        </div>
      )}
    </div>
  );
});
