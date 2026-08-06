import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props { sessionId: string; path: string; fileName: string; onClose: () => void; onSaved?: () => void }

export default function FileEditor({ sessionId, path, fileName, onClose, onSaved }: Props) {
  const [content, setContent] = useState("");
  const [orig, setOrig] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<string>("sftp_read_file", { id: sessionId, path }).then(t => { setContent(t); setOrig(t); setLoading(false); }).catch(() => setLoading(false));
  }, [sessionId, path]);

  const dirty = content !== orig;

  const save = async () => {
    setSaving(true);
    try {
      await invoke("sftp_write_file", { id: sessionId, path, content });
      setOrig(content);
      setSaving(false);
      onSaved?.();
    } catch (e) { console.error(e); setSaving(false); }
  };

  return (
    <div className="editor">
      <div className="editor-bar">
        <span className="editor-file">{fileName}</span>
        <div className="editor-actions">
          {dirty && <><button className="btn btn-sm btn-success" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button><button className="btn btn-sm btn-ghost" onClick={() => { setContent(orig); }}>Undo</button></>}
          <button className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
      {loading ? <div className="editor-load">Loading...</div> :
        <textarea className="editor-text" value={content} onChange={e => setContent(e.target.value)} spellCheck={false} />}
    </div>
  );
}
