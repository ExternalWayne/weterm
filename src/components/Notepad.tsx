import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open, ask } from "@tauri-apps/plugin-dialog";
import type { NotepadFileInfo } from "../types";
import { showToast } from "../toastStore";

const LAST_FILE_KEY = "weterm_notepad_last_file";

interface Props {
  savePath: string;
  height?: number;
  fontFamily?: string;
  fontSize?: number;
}

export default function Notepad({ savePath, height, fontFamily, fontSize }: Props) {
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState("notes.txt");
  const [files, setFiles] = useState<NotepadFileInfo[]>([]);
  const [showFiles, setShowFiles] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const loadedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState("");

  const refreshFiles = useCallback(() => {
    invoke<NotepadFileInfo[]>("list_notepad_files", { dirPath: savePath })
      .then(setFiles)
      .catch(() => {});
  }, [savePath]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  const loadFile = useCallback(async (name: string) => {
    try {
      const c = await invoke<string>("load_notepad", { dirPath: savePath, fileName: name });
      setContent(c);
      setFileName(name);
      loadedRef.current = true;
      setSaved(true);
      setShowFiles(false);
      localStorage.setItem(LAST_FILE_KEY, name);
    } catch (e) { showToast("Load failed: " + String(e)); }
  }, [savePath]);

  useEffect(() => {
    if (!loadedRef.current && files.length > 0) {
      // Reopen the last edited file if it still exists
      const lastName = localStorage.getItem(LAST_FILE_KEY);
      if (lastName && files.some(f => f.name === lastName)) {
        loadFile(lastName);
      } else {
        loadFile(files[0].name);
      }
    }
  }, [files, loadFile]);

  const autoSave = useCallback((text: string) => {
    setSaved(false);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("save_notepad", { dirPath: savePath, fileName: fileName, content: text })
        .then(() => setSaved(true))
        .catch(() => {});
    }, 1500);
  }, [savePath, fileName]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setContent(v);
    if (loadedRef.current) autoSave(v);
  };

  const handleSave = useCallback(async () => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    setSaving(true);
    try {
      await invoke("save_notepad", { dirPath: savePath, fileName: fileName, content });
      setSaved(true);
      refreshFiles();
    } catch (e) { showToast("Save to notepad failed: " + String(e)); }
    setSaving(false);
  }, [savePath, fileName, content, refreshFiles]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (saved) return; // already saved
      handleSave();
    }
  }, [saved, handleSave]);

  const handleSaveAs = async () => {
    try {
      const path = await save({
        defaultPath: "~/Desktop/" + fileName,
        filters: [{ name: "Text Files", extensions: ["txt"] }],
      });
      if (!path) return;
      await invoke("export_notepad", { content, path });
      // Also save internally
      await invoke("save_notepad", { dirPath: savePath, fileName: fileName, content });
      setSaved(true);
      refreshFiles();
    } catch (e) { showToast("Save failed: " + String(e)); }
  };

  const handleBrowseFiles = async () => {
    try {
      const result = await open({
        multiple: false,
        filters: [
          { name: "Text Files", extensions: ["txt", "md", "json", "xml", "csv", "log", "yml", "yaml", "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "py", "js", "ts", "jsx", "tsx", "html", "css", "rs", "go", "java", "c", "cpp", "h", "rb", "php", "swift", "kt"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (!result) return;
      // plugin-dialog open() returns string | string[] | null; multiple:false → string | null
      const filePath = Array.isArray(result) ? result[0] : result;
      if (!filePath) return;
      const c = await invoke<string>("local_read_file", { path: filePath });
      const name = filePath.split("/").pop() || "untitled.txt";
      setContent(c);
      setFileName(name);
      loadedRef.current = true;
      setSaved(true);
      setShowFiles(false);
      localStorage.setItem(LAST_FILE_KEY, name);
    } catch (e) { showToast("Open failed: " + String(e)); }
  };

  const handleNewFile = () => {
    const name = "new-" + Date.now() + ".txt";
    setFileName(name);
    setContent("");
    loadedRef.current = true;
    setSaved(false);
    setShowFiles(false);
    localStorage.setItem(LAST_FILE_KEY, name);
    invoke("save_notepad", { dirPath: savePath, fileName: name, content: "" })
      .then(() => refreshFiles())
      .catch(() => {});
  };

  const startRename = () => {
    setRenameName(fileName);
    setRenaming(true);
  };
  const confirmRename = async () => {
    const newName = renameName.trim();
    if (!newName || newName === fileName) { setRenaming(false); return; }
    const finalName = newName.endsWith(".txt") ? newName : newName + ".txt";
    try {
      await invoke("save_notepad", { dirPath: savePath, fileName: finalName, content });
      if (loadedRef.current) {
        await invoke("delete_notepad_file", { dirPath: savePath, fileName: fileName }).catch(() => {});
      }
      setFileName(finalName);
      localStorage.setItem(LAST_FILE_KEY, finalName);
      refreshFiles();
    } catch (e) { showToast("Rename failed: " + String(e)); }
    setRenaming(false);
  };

  const handleDeleteFile = async (name: string) => {
    const ok = await ask(`Delete "${name}"?`, { title: "Weterm", kind: "warning" });
    if (!ok) return;
    try {
      await invoke("delete_notepad_file", { dirPath: savePath, fileName: name });
      if (fileName === name) { setContent(""); setFileName("notes.txt"); }
      refreshFiles();
    } catch (e) { showToast("Delete failed: " + String(e)); }
  };

  const notepadFont = fontFamily && fontSize
    ? `${fontSize}px/1.5 ${fontFamily}`
    : `11px/1.5 'JetBrains Mono', 'SF Mono', monospace`;

  const applyDroppedData = useCallback(async (data: any) => {
    if (!data) return;
    if (data.is_dir) {
      // Folder: paste the path
      setContent(prev => prev + (prev ? "\n" : "") + data.path);
      setSaved(false);
    } else if (data.path) {
      // File: paste the path, read content, save
      try {
        const src = data._src || "";
        if (src === "local" || !data._src) {
          // Local file: read directly
          const fileContent = await invoke<string>("local_read_file", { path: data.path });
          setContent(prev => prev + (prev ? "\n" : "") + "// " + data.path + "\n" + fileContent);
        } else {
          // Remote file: paste path only (content needs SFTP read)
          setContent(prev => prev + (prev ? "\n" : "") + "// " + data.path + "\n");
        }
        setSaved(false);
      } catch (e) {
        setContent(prev => prev + (prev ? "\n" : "") + data.path);
        setSaved(false);
      }
    }
  }, []);

  const handleDropOnNotepad = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let raw = "";
    try { raw = e.dataTransfer.getData("text/plain"); } catch { /* WKWebView may block getData */ }
    let data: any = null;
    if (raw?.startsWith("weterm:")) {
      try { data = JSON.parse(raw.slice(7)); } catch {}
    } else if (raw?.startsWith("weterm-batch:")) {
      try { const arr = JSON.parse(raw.slice(14)); data = arr[0]; } catch {}
    }
    await applyDroppedData(data);
  };

  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onPointerDrop = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (Array.isArray(detail)) {
        applyDroppedData(detail[0]);
      }
    };
    el.addEventListener("weterm-pointer-drop", onPointerDrop);
    return () => el.removeEventListener("weterm-pointer-drop", onPointerDrop);
  }, [applyDroppedData]);

  return (
    <div ref={wrapRef} data-drop-zone="notepad" className={`notepad-wrap ${dragOver ? "np-drop-highlight" : ""}`} style={{ flex: height !== undefined ? `0 0 ${height}px` : "0 0 160px" }}
      onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={e => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false);
        }
      }}
      onDrop={e => { setDragOver(false); handleDropOnNotepad(e); }}>
      {/* Header */}
      <div className="al-header">
        <span
          className="np-header-title"
          onClick={() => { refreshFiles(); setShowFiles(!showFiles); }}
          title="Browse saved documents"
        >
          📝 Notepad
          {renaming ? (
            <input
              className="np-rename-input"
              value={renameName}
              onChange={e => setRenameName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") confirmRename(); if (e.key === "Escape") setRenaming(false); }}
              onBlur={confirmRename}
              autoFocus
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span
              className="np-filename"
              onClick={e => { e.stopPropagation(); startRename(); }}
              title="Click to rename"
            >{fileName}</span>
          )}
          <span className="np-save-status">{saving ? "(saving...)" : saved ? "" : "●"}</span>
        </span>
      </div>
      {/* Toolbar — wraps when panel is narrow */}
      <div className="np-toolbar">
        <button onClick={() => { refreshFiles(); setShowFiles(!showFiles); }} title="Browse saved documents" className="btn btn-sm">{showFiles ? "▲" : ""} Browse</button>
        <button onClick={handleNewFile} title="Create a new document" className="btn btn-sm">New</button>
        <button onClick={handleBrowseFiles} title="Open a file from your Mac" className="btn btn-sm">Open</button>
        <button onClick={handleSave} title="Save to Weterm notepad" className="btn btn-sm">Save</button>
        <button onClick={handleSaveAs} title="Export to a file on your Mac" className="btn btn-sm">Export</button>
      </div>

      {/* File list dropdown */}
      {showFiles && (
        <div className="np-file-list">
          {files.length === 0 ? (
            <div className="al-empty">No saved documents</div>
          ) : (
            files.map(f => (
              <div key={f.name} className={`np-file-item${f.name === fileName ? " active" : ""}`}>
                <span className="np-file-info" onClick={() => loadFile(f.name)}>
                  📄 {f.name}
                  <span className="np-file-meta">{f.modified}</span>
                </span>
                <button className="np-file-delete" onClick={e => { e.stopPropagation(); handleDeleteFile(f.name); }} title="Delete">✕</button>
              </div>
            ))
          )}
        </div>
      )}

      <textarea
        className="notepad-area"
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Click here to type notes... (auto-saves, Ctrl+S to save)"
        style={{ font: notepadFont }}
      />
    </div>
  );
}
