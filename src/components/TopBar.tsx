import { useState, useEffect } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import type { SessionConfig, SavedConnection } from "../types";

interface Props {
  sessions: SessionConfig[];
  tabNumbers: Record<string, number>;
  activeId: string | null;
  prefillConn: SavedConnection | null;
  history: SavedConnection[];
  onConnect: (c: SessionConfig) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpenSettings: () => void;
  onReconnect?: (id: string) => void;
  onReconnectSaved?: (s: SavedConnection) => void;
  onCloneTab?: (id: string) => void;
  onDeleteConnection?: (s: SavedConnection) => void;
}

export default function TopBar({ sessions, tabNumbers, activeId, prefillConn, history, onConnect, onSelect, onClose, onOpenSettings, onReconnect, onReconnectSaved, onCloneTab, onDeleteConnection }: Props) {
  const [show, setShow] = useState(false);
  const [brandMenu, setBrandMenu] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [nickname, setNickname] = useState("");
  const [pass, setPass] = useState("");
  const [auth, setAuth] = useState<"password"|"key"|"agent">("password");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Close brand menu on outside click
  useEffect(() => {
    if (!brandMenu) return;
    const close = () => setBrandMenu(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", onKey); };
  }, [brandMenu]);

  // Close tab context menu on outside click
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", onKey); };
  }, [tabMenu]);

  // When prefillConn is set (from history click), populate form and show modal
  useEffect(() => {
    if (prefillConn) {
      setHost(prefillConn.host);
      setPort(prefillConn.port);
      setUser(prefillConn.username);
      setNickname(prefillConn.name && prefillConn.name !== `${prefillConn.username}@${prefillConn.host}:${prefillConn.port}` ? prefillConn.name : "");
      setAuth((prefillConn.authType as any) || "password");
      setPass("");
      setKey(prefillConn.keyPath || "");
      setErr("");
      setShow(true);
    }
  }, [prefillConn]);

  const connect = async () => {
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
      setShow(false);
      setHost(""); setPort(22); setUser(""); setNickname(""); setPass(""); setKey("");
    } catch (e) { setErr(String(e)); }
    setBusy(false);
  };

  const close = () => {
    setShow(false);
    setErr("");
    setNickname("");
  };

  return (
    <div className="topbar">
      <div className="topbar-brand" onClick={e => { e.stopPropagation(); setBrandMenu(!brandMenu); }}>
        <img src="/weterm-blink.gif" alt="" style={{width:18,height:18,flexShrink:0}} />
        <span className="topbar-brand-text">Weterm</span>
        {brandMenu && (
          <div className="brand-menu">
            <div className="brand-menu-item" onClick={() => { onOpenSettings(); setBrandMenu(false); }}>⚙ Settings</div>
            <div className="brand-menu-item" onClick={() => { window.location.href = "mailto:weterm@foxmail.com?subject=Weterm%20Feedback"; setBrandMenu(false); }} title="Send feedback via email">✉ Feedback <span style={{color: "var(--fg3)", fontSize: "var(--fs-xs)"}}>weterm@foxmail.com</span></div>
            <div className="brand-menu-item" onClick={() => { setBrandMenu(false); setShowAbout(true); }} title="About Weterm">ℹ About Weterm</div>
            <div className="brand-menu-sep" />
            <div className="brand-menu-item muted">Weterm v1.0.0 — Νείλος</div>
          </div>
        )}
      </div>
      <div className="topbar-tabs">
        {sessions.map(s => (
          <div key={s.id} className={`topbar-tab ${activeId === s.id ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
            onContextMenu={e => { e.preventDefault(); setTabMenu({ x: e.clientX, y: e.clientY, sessionId: s.id }); }}>
            <span className="dot" /><span>#{tabNumbers[s.id] ?? "?"} {s.name}</span>
            <button className="tab-close" onClick={e => { e.stopPropagation(); onClose(s.id); }}>×</button>
          </div>
        ))}
      </div>
      <button className="topbar-add" onClick={() => setShow(!show)}>{show ? "✕" : "+"}</button>
      {show && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <h3>New Connection</h3>

            {/* ── Saved connections (history) ── */}
            {history.length > 0 && (
              <div className="cp-section" style={{ marginBottom: 12 }}>
                <div className="cp-section-title">History</div>
                <div className="cp-history-list" style={{ maxHeight: 160, overflowY: "auto" }}>
                  {history.map((s, i) => (
                    <div key={i} className="cp-history-item"
                      onDoubleClick={() => { onReconnectSaved?.(s); setShow(false); close(); }}
                      title="Double-click to connect">
                      <span className="ico ico-d" />
                      <span className="cp-h-name">{s.name}</span>
                      <span className="cp-h-detail">{s.username}@{s.host}:{s.port}</span>
                      <button className="cp-history-del" onClick={e => { e.stopPropagation(); ask(`Delete "${s.name}"?`, { title: "Weterm", kind: "warning" }).then(ok => { if (ok) onDeleteConnection?.(s); }); }} title="Delete connection">✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── New connection form ── */}
            <div className="fg"><label>Nickname <span style={{color: "var(--fg3)", fontWeight: 400}}>(optional)</span></label><input value={nickname} onChange={e => setNickname(e.target.value)} placeholder="My Server" /></div>
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
            <button className="btn btn-block" onClick={connect} disabled={busy}>{busy ? "Connecting..." : "Connect"}</button>
          </div>
        </div>
      )}

      {/* Tab right-click context menu */}
      {tabMenu && (() => {
        const s = sessions.find(x => x.id === tabMenu.sessionId);
        if (!s) return null;
        return (
          <div className="context-menu" style={{ left: tabMenu.x, top: tabMenu.y }}>
            <div className="cm-item" onClick={() => { onCloneTab?.(tabMenu.sessionId); setTabMenu(null); }}>
              <span className="cm-icon">⎘</span>Clone Tab
            </div>
            <div className="cm-item" onClick={() => { onReconnect?.(tabMenu.sessionId); setTabMenu(null); }}>
              <span className="cm-icon">🔄</span>Reconnect
            </div>
          </div>
        );
      })()}

      {/* About modal */}
      {showAbout && (
        <div className="modal-overlay" onClick={() => setShowAbout(false)}>
          <div className="modal about-modal" onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: "center" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 12 }}>
                <img src="/weterm-blink.gif" alt="" style={{ width: 32, height: 32 }} />
                <h3 style={{ margin: 0 }}>Weterm</h3>
              </div>
              <p style={{ color: "var(--fg2)", fontSize: "var(--fs-lg)", margin: "4px 0" }}>Version 1.0.0</p>
              <p style={{ color: "var(--ac)", fontSize: "var(--fs-md)", margin: "4px 0", fontWeight: 500 }}>Νείλος</p>
              <div style={{ height: 1, background: "var(--bd)", margin: "12px 0" }} />
              <p style={{ color: "var(--fg3)", fontSize: "var(--fs-sm)", margin: "4px 0" }}>© 2025 Benz lau</p>
              <p style={{ color: "var(--fg3)", fontSize: "var(--fs-sm)", margin: "4px 0" }}>weterm@foxmail.com</p>
              <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setShowAbout(false)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
