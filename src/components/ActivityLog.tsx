import { useState, memo } from "react";
import type { ActivityEntry, CustomCommand } from "../types";

interface Props {
  entries: ActivityEntry[];
  width: number;
  maxDisplay: number;
  onDoubleClickEntry?: (entry: ActivityEntry) => void;
  customCommands?: CustomCommand[];
  onAddCustomCommand?: (name: string, command: string) => void;
  onDeleteCustomCommand?: (id: string) => void;
  onDoubleClickCustomCommand?: (cmd: CustomCommand) => void;
}

export default memo(function ActivityLog({ entries, width, maxDisplay, onDoubleClickEntry, customCommands, onAddCustomCommand, onDeleteCustomCommand, onDoubleClickCustomCommand }: Props) {
  const collapsed = width === 0;
  const [showCustom, setShowCustom] = useState(true);
  const [showAddCmd, setShowAddCmd] = useState(false);
  const [newCmdName, setNewCmdName] = useState("");
  const [newCmdCommand, setNewCmdCommand] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const q = searchQuery.trim().toLowerCase();
  const commands = entries
    .filter(e => e.type === "command")
    .filter(e => !q || e.detail.toLowerCase().includes(q))
    .slice(0, maxDisplay);

  // Group by day
  const groups: { label: string; entries: typeof commands }[] = [];
  let currentLabel = "";
  for (const e of commands) {
    const d = new Date(e.timestamp);
    const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (label !== currentLabel) {
      currentLabel = label;
      groups.push({ label, entries: [] });
    }
    groups[groups.length - 1].entries.push(e);
  }

  const handleAdd = () => {
    const name = newCmdName.trim();
    const cmd = newCmdCommand.trim();
    if (!name || !cmd) return;
    onAddCustomCommand?.(name, cmd);
    setNewCmdName("");
    setNewCmdCommand("");
    setShowAddCmd(false);
  };

  return (
    <div className="activity-log" style={{ width, minWidth: collapsed ? 0 : 160 }}>
      <div className="al-header">
        <span className="al-title">Commands</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto" }}>
          {showCustom && (
            <button className="btn btn-sm" onClick={() => setShowAddCmd(!showAddCmd)} title="Add custom command">
              {showAddCmd ? "✕ Cancel" : "+ New"}
            </button>
          )}
          <button className="al-toggle-btn"
            onClick={() => setShowCustom(!showCustom)}
            title={showCustom ? "Show command history" : "Show custom commands"}
          >{showCustom ? "History" : "Custom"}</button>
        </span>
      </div>
      {!collapsed && (
        <div className="al-body">
          {/* Search filter */}
          <div className="fb-search">
            <input
              className="fb-search-input"
              placeholder={showCustom ? "Search custom commands..." : "Search history..."}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === "Escape") setSearchQuery(""); }}
            />
          </div>
          {showCustom ? (
            /* ── Custom Commands View ── */
            <div className="al-custom-section">
              {showAddCmd && (
                <div className="al-custom-form">
                  <input
                    className="al-custom-input"
                    placeholder="Name (e.g. Deploy)"
                    value={newCmdName}
                    onChange={e => setNewCmdName(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleAdd()}
                  />
                  <input
                    className="al-custom-input"
                    placeholder="Command (e.g. ./deploy.sh)"
                    value={newCmdCommand}
                    onChange={e => setNewCmdCommand(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleAdd()}
                  />
                  <button className="btn btn-sm" onClick={handleAdd}>Add</button>
                </div>
              )}
              {(customCommands?.length ?? 0) > 0 ? (
                <div className="al-custom-list">
                  {customCommands!
                    .filter(cmd => !q || cmd.name.toLowerCase().includes(q) || cmd.command.toLowerCase().includes(q))
                    .map((cmd, i) => (
                    <div
                      key={cmd.id}
                      className="al-custom-item"
                      onDoubleClick={() => onDoubleClickCustomCommand?.(cmd)}
                      title={`${cmd.name}: ${cmd.command}\nDouble-click to send to terminal`}
                    >
                      <span className="al-icon al-custom-num">{i + 1}</span>
                      <span className="al-custom-name">{cmd.name}</span>
                      <span className="al-custom-cmd">{cmd.command}</span>
                      <button
                        className="tp-cancel"
                        onClick={e => { e.stopPropagation(); onDeleteCustomCommand?.(cmd.id); }}
                        title="Delete"
                      >✕</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="al-empty">{q ? "No matches" : "No custom commands"}</div>
              )}
            </div>
          ) : (
            /* ── Command History View ── */
            groups.length === 0 ? (
              <div className="al-empty">No commands yet</div>
            ) : (
              groups.map((g, gi) => (
                <div key={gi}>
                  <div className="al-day-sep">{g.label}</div>
                  {g.entries.map(entry => (
                    <div key={entry.id} className="al-entry"
                      onDoubleClick={() => onDoubleClickEntry?.(entry)}
                      title="Double-click to insert into terminal">
                      <span className="al-icon">❯</span>
                      <span className="al-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                      <span className="al-detail">{entry.detail}</span>
                    </div>
                  ))}
                </div>
              ))
            )
          )}
        </div>
      )}
    </div>
  );
});
