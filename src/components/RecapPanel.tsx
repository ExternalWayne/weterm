import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { getTerminalTheme } from "../terminalTheme";
import { showToast } from "../toastStore";

interface RecapEvent { t: number; d: string; type: "output" | "input"; }

interface RecordingSummary {
  id: string; name: string; session: string;
  started_at: number; event_count: number; size_bytes: number;
}

interface RecordingDetail {
  id: string; name: string; session: string;
  started_at: number; events: RecapEvent[];
}

interface Props {
  onClose: () => void;
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1048576).toFixed(1)}MB`;
}

export default function RecapPanel({ onClose }: Props) {
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [selected, setSelected] = useState<RecordingDetail | null>(null);
  const [playing, setPlaying] = useState(false);
  const replayRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const eventIdxRef = useRef(0);
  const startTimeRef = useRef(0);

  const loadList = async () => {
    try {
      const list = await invoke<RecordingSummary[]>("list_recordings");
      setRecordings(list);
    } catch { /* ignore */ }
  };

  useEffect(() => { loadList(); }, []);

  const loadAndPlay = async (id: string) => {
    stopPlayback();
    try {
      const detail = await invoke<RecordingDetail>("load_recording", { id });
      setSelected(detail);
    } catch (e) { showToast("Load failed: " + String(e)); }
  };

  const startPlayback = () => {
    if (!selected || !replayRef.current) return;
    if (termRef.current) { termRef.current.dispose(); termRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    const t = new Terminal({
      cursorBlink: false, scrollback: 5000,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      theme: getTerminalTheme(),
      disableStdin: true,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(replayRef.current);
    fit.fit();
    termRef.current = t;

    eventIdxRef.current = 0;
    startTimeRef.current = Date.now();
    setPlaying(true);

    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const events = selected.events;
      let idx = eventIdxRef.current;
      while (idx < events.length && events[idx].t <= elapsed) {
        t.write(events[idx].d);
        idx++;
      }
      eventIdxRef.current = idx;
      if (idx >= events.length) {
        stopPlayback();
      }
    }, 30);
  };

  const stopPlayback = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setPlaying(false);
  };

  const handleDelete = async (id: string) => {
    try {
      await invoke("delete_recording", { id });
      if (selected?.id === id) { setSelected(null); stopPlayback(); }
      loadList();
    } catch (e) { showToast("Delete failed: " + String(e)); }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (termRef.current) termRef.current.dispose();
    };
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal recap-panel" onClick={e => e.stopPropagation()} style={{ width: 700, maxHeight: "85vh" }}>
        <div className="settings-header">
          <h3>Recap — Session Recordings</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>
        <div className="recap-layout">
          {/* Left: recording list */}
          <div className="recap-list">
            <div className="recap-list-toolbar">
              <button className="cp-new-btn" onClick={loadList}>↻ Refresh</button>
            </div>
            <div className="recap-list-body">
              {recordings.length === 0 ? (
                <div className="al-empty">No recordings yet</div>
              ) : (
                recordings.map(r => (
                  <div
                    key={r.id}
                    className={`cp-history-item${selected?.id === r.id ? " selected" : ""}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => loadAndPlay(r.id)}
                  >
                    <div className="recap-item-info">
                      <div className="recap-item-name">{r.name}</div>
                      <div className="recap-item-meta">
                        {r.session} · {r.event_count} events · {fmtSize(r.size_bytes)}
                      </div>
                      <div className="recap-item-time">
                        {new Date(r.started_at).toLocaleString()}
                      </div>
                    </div>
                    <button
                      className="tp-cancel"
                      onClick={e => { e.stopPropagation(); handleDelete(r.id); }}
                      title="Delete"
                    >✕</button>
                  </div>
                ))
              )}
            </div>
          </div>
          {/* Right: player */}
          <div className="recap-player">
            {selected ? (
              <>
                <div className="recap-player-bar">
                  <span className="recap-player-title">{selected.name}</span>
                  {!playing ? (
                    <button className="btn btn-sm" onClick={startPlayback}>▶ Play</button>
                  ) : (
                    <button className="btn btn-sm" onClick={stopPlayback}>⏹ Stop</button>
                  )}
                </div>
                <div ref={replayRef} className="recap-terminal" />
              </>
            ) : (
              <div className="al-empty" style={{ marginTop: 50 }}>Select a recording to play</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
