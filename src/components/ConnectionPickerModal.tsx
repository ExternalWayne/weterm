import { useState, useEffect } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { SavedConnection, SessionConfig } from "../types";

interface Props {
  title: string;
  history: SavedConnection[];
  onConnect: (config: SessionConfig) => Promise<void>;
  onReconnect: (saved: SavedConnection) => void;
  onUpdateConnection?: (old: SavedConnection, updated: SavedConnection, newPassword?: string) => void;
  onDeleteConnection?: (saved: SavedConnection) => void;
  onLocal: () => void;
  onClose: () => void;
  allowLocal?: boolean;
}

export default function ConnectionPickerModal({ title, history, onConnect, onReconnect, onUpdateConnection, onDeleteConnection, onLocal, onClose, allowLocal = true }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [editingConn, setEditingConn] = useState<SavedConnection | null>(null);
  const [nickname, setNickname] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [auth, setAuth] = useState<"password" | "key" | "agent">("password");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const startEdit = (s: SavedConnection) => {
    setEditingConn(s);
    setNickname(s.name);
    setHost(s.host);
    setPort(s.port);
    setUser(s.username);
    setAuth(s.authType as "password" | "key" | "agent");
    setPass("");
    setKey(s.keyPath || "");
    setErr("");
    setShowForm(false);
  };

  const cancelEdit = () => {
    setEditingConn(null);
    setNickname("");
    setHost("");
    setPort(22);
    setUser("");
    setPass("");
    setKey("");
    setErr("");
  };

  const saveEdit = () => {
    if (!editingConn) return;
    if (!nickname.trim() || !host || !user) { setErr("Nickname, host and username required"); return; }
    const updated: SavedConnection = {
      name: nickname.trim(),
      host,
      port,
      username: user,
      authType: auth,
      keyPath: auth === "key" ? key.trim() : undefined,
      hasKeychainSecret: auth === "password",
    };
    onUpdateConnection?.(editingConn, updated, auth === "password" && pass ? pass : undefined);
    cancelEdit();
  };

  const doConnect = async () => {
    if (!host || !user) { setErr("Host and username required"); return; }
    setBusy(true); setErr("");
    const id = crypto.randomUUID();
    const cfg: SessionConfig = {
      id, name: nickname.trim() || `${user}@${host}:${port}`, host, port, username: user,
      authType: auth,
      password: auth === "password" ? pass : undefined,
      keyPath: auth === "key" ? key : undefined,
    };
    try {
      await onConnect(cfg);
      onClose();
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal conn-picker-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h3>{title}</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="cp-body">
          {/* Editing form — shown instead of everything else when editing */}
          {editingConn ? (
            <div className="cp-section">
              <div className="cp-section-title">Edit Connection</div>
              <div className="fg"><label>Nickname</label><input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="My Server" /></div>
              <div className="fg"><label>Host</label><input value={host} onChange={e => setHost(e.target.value)} placeholder="example.com" /></div>
              <div className="fr">
                <div className="fg"><label>Port</label><input type="number" value={port} onChange={e => setPort(Number(e.target.value))} /></div>
                <div className="fg"><label>Username</label><input value={user} onChange={e => setUser(e.target.value)} placeholder="root" /></div>
              </div>
              <div className="fg"><label>Auth</label>
                <select value={auth} onChange={e => setAuth(e.target.value as any)}>
                  <option value="password">Password</option>
                  <option value="key">Key</option>
                  <option value="agent">Agent</option>
                </select>
              </div>
              {auth === "password" && <div className="fg"><label>Password (leave blank to keep existing)</label><input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="New password" /></div>}
              {auth === "key" && <div className="fg"><label>Key Path</label><input value={key} onChange={e => setKey(e.target.value)} placeholder="/path/to/id_rsa" /></div>}
              {err && <div className="error">{err}</div>}
              <div className="cp-form-actions">
                <button className="btn btn-sm btn-ghost" onClick={cancelEdit}>Cancel</button>
                <button className="btn" onClick={saveEdit}>Save</button>
              </div>
            </div>
          ) : (
            <>
              {/* History section */}
              <div className="cp-section">
                <div className="cp-section-title">History</div>
                {history.length === 0 ? (
                  <div className="cp-empty">No saved connections</div>
                ) : (
                  <div className="cp-history-list">
                    {history.map((s, i) => (
                      <div key={i} className="cp-history-item"
                        onDoubleClick={() => { onReconnect(s); onClose(); }}
                        title="Double-click to connect · Click ✐ to edit">
                        <span className="ico ico-d" />
                        <span className="cp-h-name">{s.name}</span>
                        <span className="cp-h-detail">{s.username}@{s.host}:{s.port}</span>
                        <button className="cp-history-edit" onClick={e => { e.stopPropagation(); startEdit(s); }} title="Edit connection">✐</button>
                        <button className="cp-history-del" onClick={e => { e.stopPropagation(); ask(`Delete "${s.name}"?`, { title: "Weterm", kind: "warning" }).then(ok => { if (ok) onDeleteConnection?.(s); }); }} title="Delete connection">✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* New connection section */}
              <div className="cp-section">
                {!showForm ? (
                  <button className="cp-new-btn" onClick={() => { setNickname(""); setHost(""); setPort(22); setUser(""); setPass(""); setKey(""); setAuth("password"); setErr(""); setShowForm(true); }}>
                    + New Connection
                  </button>
                ) : (
                  <>
                    <div className="cp-section-title">New Connection</div>
                    <div className="fg"><label>Nickname (optional)</label><input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="e.g. My Server" /></div>
                    <div className="fg"><label>Host</label><input value={host} onChange={e => setHost(e.target.value)} placeholder="example.com" /></div>
                    <div className="fr">
                      <div className="fg"><label>Port</label><input type="number" value={port} onChange={e => setPort(Number(e.target.value))} /></div>
                      <div className="fg"><label>Username</label><input value={user} onChange={e => setUser(e.target.value)} placeholder="root" /></div>
                    </div>
                    <div className="fg"><label>Auth</label>
                      <select value={auth} onChange={e => setAuth(e.target.value as any)}>
                        <option value="password">Password</option>
                        <option value="key">Key</option>
                        <option value="agent">Agent</option>
                      </select>
                    </div>
                    {auth === "password" && <div className="fg"><label>Password</label><input type="password" value={pass} onChange={e => setPass(e.target.value)} /></div>}
                    {auth === "key" && <div className="fg"><label>Key Path</label><input value={key} onChange={e => setKey(e.target.value)} placeholder="/path/to/id_rsa" /></div>}
                    {err && <div className="error">{err}</div>}
                    <div className="cp-form-actions">
                      <button className="btn btn-sm btn-ghost" onClick={() => { setShowForm(false); setNickname(""); setErr(""); }}>Cancel</button>
                      <button className="btn" onClick={doConnect} disabled={busy}>{busy ? "Connecting..." : "Connect"}</button>
                    </div>
                  </>
                )}
              </div>

              {/* Local option — only for bottom panel */}
              {allowLocal && (
                <div className="cp-section">
                  <button className="cp-local-btn" onClick={() => { onLocal(); onClose(); }}>
                    💻 Browse Local Files
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
