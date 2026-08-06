import type { StatusInfo } from "../App";

interface Props {
  statusInfo: StatusInfo;
  isConnected: boolean;
  showCpu: boolean;
  showMem: boolean;
  showLoginTime: boolean;
  showDuration: boolean;
  statusStyle: "text" | "circles";
}

function duration(ms: number): string {
  if (!ms) return "--";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

function loginTimeStr(ms: number): string {
  if (!ms) return "--";
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function toPct(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function Ring({ value, color, label, title }: {
  value: number;
  color: string;
  label: string;
  title: string;
}) {
  return (
    <span className="bb-ring-item" title={title}>
      <span className="bb-ring-label">{label}</span>
      <span
        className="bb-ring"
        style={{ background: `conic-gradient(${color} ${value * 3.6}deg, var(--bd) 0deg)` }}
      >
        <span className="bb-ring-inner">
          <span className="bb-ring-value">{Math.round(value)}%</span>
        </span>
      </span>
    </span>
  );
}

export default function BottomBar({
  statusInfo, isConnected, showCpu, showMem, showLoginTime, showDuration, statusStyle,
}: Props) {
  const anyInfo = showCpu || showMem || showLoginTime || showDuration;
  const memTotal = parseFloat(statusInfo.memTotalGb);
  const memUsed = parseFloat(statusInfo.memUsedGb);
  const memPct = Number.isFinite(memTotal) && Number.isFinite(memUsed) && memTotal > 0
    ? Math.max(0, Math.min(100, (memUsed / memTotal) * 100))
    : 0;
  const circles = statusStyle === "circles" && isConnected;

  return (
    <div className="bottom-bar">
      <div className="bb-left">
        {isConnected ? (
          <>
            {circles ? (
              <>
                {showCpu && (
                  <Ring
                    value={toPct(statusInfo.cpuPercent)}
                    color="var(--ac)"
                    label="CPU"
                    title={`CPU ${statusInfo.cpuPercent}%`}
                  />
                )}
                {showMem && (
                  <Ring
                    value={memPct}
                    color="var(--grn)"
                    label="MEM"
                    title={`Memory ${statusInfo.memUsedGb}/${statusInfo.memTotalGb} GB`}
                  />
                )}
              </>
            ) : (
              <>
                {showCpu && (
                  <span className="bb-item" title="CPU usage">
                    <span className="bb-label">CPU</span> {statusInfo.cpuPercent}%
                  </span>
                )}
                {showMem && (
                  <span className="bb-item" title="Memory used / total">
                    <span className="bb-label">MEM</span> {statusInfo.memUsedGb}/{statusInfo.memTotalGb}GB
                  </span>
                )}
              </>
            )}
            {showLoginTime && (
              <span className="bb-item" title="Login time">
                <span className="bb-label">Login</span> {loginTimeStr(statusInfo.loginTime)}
              </span>
            )}
            {showDuration && (
              <span className="bb-item" title="Connected for">
                <span className="bb-label">Up</span> {duration(statusInfo.connectedSince)}
              </span>
            )}
            {!anyInfo && <span className="bb-item muted">Connected</span>}
          </>
        ) : (
          <span className="bb-item muted">Not connected</span>
        )}
      </div>
    </div>
  );
}
