import { useEffect, useRef, memo, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MonitorData } from "../types";

interface Props {
  isRemote: boolean;
  sessionId: string | null;
  width: number;
}

function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1048576) return `${(bps / 1024).toFixed(1)} KB/s`;
  if (bps < 1073741824) return `${(bps / 1048576).toFixed(1)} MB/s`;
  return `${(bps / 1073741824).toFixed(2)} GB/s`;
}

function niceRoundup(max: number): number {
  if (max <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function drawChart(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  data: number[],
  color: string,
  fillColor: string,
  label: string,
  darkBg: string,
  gridColor: string,
  textColor: string,
) {
  const padding = { top: 20, right: 52, bottom: 18, left: 10 };
  const pw = w - padding.left - padding.right;
  const ph = h - padding.top - padding.bottom;
  if (pw <= 0 || ph <= 0) return;

  ctx.fillStyle = darkBg;
  ctx.fillRect(0, 0, w, h);

  const maxVal = data.length > 0 ? Math.max(...data, 1) : 1;
  const yMax = niceRoundup(maxVal);

  // Grid lines + Y labels
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  ctx.font = "9px -apple-system, sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (ph * i / 4);
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(w - padding.right, y); ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.fillText(fmtSpeed(yMax * (1 - i / 4)), w - padding.right - 3, y + 3);
  }

  // X-axis labels
  ctx.textAlign = "center";
  ctx.fillStyle = textColor;
  for (let s = 0; s <= 60; s += 15) {
    const x = padding.left + (pw * s / 60);
    ctx.fillText(`${s}s`, x, h - 3);
  }

  if (data.length === 0) {
    ctx.fillStyle = color;
    ctx.font = "bold 10px -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, padding.left, padding.top - 4);
    return;
  }

  const baseline = padding.top + ph; // x-axis y position

  // Build path for area fill + line
  if (data.length >= 2) {
    // Fill area under curve
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.moveTo(padding.left, baseline);
    for (let i = 0; i < data.length; i++) {
      const x = padding.left + (pw * i / 59);
      const y = padding.top + ph - (data[i] / yMax * ph);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(padding.left + (pw * (data.length - 1) / 59), baseline);
    ctx.closePath();
    ctx.fill();

    // Draw line on top
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = padding.left + (pw * i / 59);
      const y = padding.top + ph - (data[i] / yMax * ph);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else if (data.length === 1) {
    // Single point: draw dot only
    const x = padding.left;
    const y = padding.top + ph - (data[0] / yMax * ph);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  // Latest dot
  const li = data.length - 1;
  const lx = padding.left + (pw * li / 59);
  const ly = padding.top + ph - (data[li] / yMax * ph);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fill();

  // Label + current speed
  ctx.fillStyle = color;
  ctx.font = "bold 10px -apple-system, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(label, padding.left, padding.top - 4);

  ctx.fillStyle = textColor;
  ctx.font = "9px -apple-system, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(fmtSpeed(data[li]), w - padding.right, padding.top - 4);
}

export default memo(function MonitorPanel({ isRemote, sessionId, width }: Props) {
  const collapsed = width === 0;
  const uploadRef = useRef<HTMLCanvasElement>(null);
  const downloadRef = useRef<HTMLCanvasElement>(null);
  const uploadData = useRef<number[]>([]);
  const downloadData = useRef<number[]>([]);
  const [stats, setStats] = useState<MonitorData | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  const redraw = useCallback(() => {
    const uC = uploadRef.current;
    const dC = downloadRef.current;
    if (!uC || !dC) return;
    const s = getComputedStyle(document.documentElement);
    const darkBg = s.getPropertyValue("--bg").trim() || "#1c1c1e";
    const gridColor = s.getPropertyValue("--fg3").trim() + "26" || "#6e6e7326";
    const textColor = s.getPropertyValue("--fg3").trim() || "#6e6e73";
    const upColor = s.getPropertyValue("--ac").trim() || "#0a84ff";
    const downColor = s.getPropertyValue("--red").trim() || "#ff453a";

    const dpr = window.devicePixelRatio || 1;
    for (const [ref, color, fillColor, label, data] of [
      [uC, upColor, upColor + "26", "Upload", uploadData.current],
      [dC, downColor, downColor + "26", "Download", downloadData.current],
    ] as const) {
      const rect = ref.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      if (w <= 0 || h <= 0) continue;
      ref.width = w * dpr;
      ref.height = h * dpr;
      const ctx = ref.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawChart(ctx, w, h, data, color, fillColor, label, darkBg, gridColor, textColor);
    }
  }, []);

  // ── Local: listen for background-thread events (off main thread) ──
  useEffect(() => {
    if (collapsed || isRemote) return;
    // Start the Rust background monitoring thread
    invoke("start_monitor").catch(() => {});
    const unlisten = listen<MonitorData>("monitor-data", (event) => {
      const data = event.payload;
      setStats(data);

      uploadData.current.push(data.netTxBytesPerSec);
      downloadData.current.push(data.netRxBytesPerSec);
      if (uploadData.current.length > 60) uploadData.current.shift();
      if (downloadData.current.length > 60) downloadData.current.shift();

      requestAnimationFrame(redraw);
    });

    return () => {
      invoke("stop_monitor").catch(() => {});
      unlisten.then(fn => fn());
    };
  }, [collapsed, isRemote, redraw]);

  // ── Remote: poll at 2s (SSH latency makes 1s wasteful) ──
  useEffect(() => {
    if (collapsed || !isRemote || !sessionId) return;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const data = await invoke<MonitorData>("get_remote_monitor_data", { id: sessionId });
        if (cancelled) return;
        setStats(data);

        uploadData.current.push(data.netTxBytesPerSec);
        downloadData.current.push(data.netRxBytesPerSec);
        if (uploadData.current.length > 60) uploadData.current.shift();
        if (downloadData.current.length > 60) downloadData.current.shift();

        requestAnimationFrame(redraw);
      } catch { /* ignore */ }
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [collapsed, isRemote, sessionId, redraw]);

  // ResizeObserver for canvas resize on layout changes
  useEffect(() => {
    const uC = uploadRef.current;
    if (!uC || collapsed) return;
    const ro = new ResizeObserver(() => requestAnimationFrame(redraw));
    ro.observe(uC);
    return () => ro.disconnect();
  }, [redraw, collapsed]);

  // Redraw when panel width changes
  useEffect(() => {
    requestAnimationFrame(redraw);
  }, [width, redraw]);

  const cpuPct = Math.min(100, stats?.cpuPercent ?? 0);
  const memPct = stats && stats.memTotalGb > 0 ? Math.min(100, (stats.memUsedGb / stats.memTotalGb) * 100) : 0;

  return (
    <div className="monitor-panel" style={{ width, minWidth: collapsed ? 0 : 160 }}>
      <div className="al-header">
        <span className="tp-title">Monitor</span>
      </div>
      {!collapsed && (
        <div className="mon-body">
          <div className="mon-charts">
            <div className="mon-chart-wrap">
              <canvas ref={uploadRef} className="mon-canvas" />
            </div>
            <div className="mon-chart-wrap">
              <canvas ref={downloadRef} className="mon-canvas" />
            </div>
          </div>
          <div className="mon-stats">
            {/* CPU Vertical Bar */}
            <div className="mon-vbar-group">
              <span className="mon-label">CPU</span>
              <div className="mon-vbar-track">
                <div className="mon-vbar-fill mon-vbar-cpu" style={{ height: `${cpuPct}%` }} />
              </div>
              <span className="mon-value">{stats ? `${stats.cpuPercent.toFixed(1)}%` : "--"}</span>
            </div>
            {/* MEM Vertical Bar */}
            <div className="mon-vbar-group">
              <span className="mon-label">MEM</span>
              <div className="mon-vbar-track">
                <div className="mon-vbar-fill mon-vbar-mem" style={{ height: `${memPct}%` }} />
              </div>
              <span className="mon-value">{stats ? `${stats.memUsedGb.toFixed(1)}/${stats.memTotalGb.toFixed(1)}` : "--"}</span>
            </div>
            {/* Top Processes */}
            <div className="mon-processes">
              <div className="mon-process-header">
                <span>PROCESS</span><span>CPU</span><span>MEM</span>
              </div>
              <div className="mon-process-body">
                {stats?.topProcesses?.length ? stats.topProcesses.map((p, i) => (
                  <div key={i} className="mon-process-row">
                    <span className="mon-proc-name" title={`PID ${p.pid}: ${p.name}`}>{p.name}</span>
                    <span className="mon-proc-cpu">{p.cpuPercent.toFixed(1)}%</span>
                    <span className="mon-proc-mem">{p.memPercent.toFixed(1)}%</span>
                  </div>
                )) : (
                  <div className="tp-empty" style={{ padding: "var(--sp-4)", fontSize: "var(--fs-xs)" }}>No data</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
