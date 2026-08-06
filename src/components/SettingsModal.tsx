import { useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import type { AppSettings } from "../types";
import { showToast } from "../toastStore";

interface Props {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
  onClose: () => void;
  onResetDefaults: () => void;
}

// All available fonts (sans-serif + monospace, free for commercial use)
const SANS_FONTS = [
  "Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto",
  "Helvetica Neue", "Arial", "Noto Sans", "Open Sans", "Lato",
  "Source Sans Pro", "PT Sans", "IBM Plex Sans", "Fira Sans",
  "Ubuntu", "Oxygen", "Droid Sans", "Work Sans", "Nunito",
  "Rubik", "Poppins", "Raleway", "Montserrat", "Mulish",
  "Manrope", "Inter Tight", "Lexend", "DM Sans", "Be Vietnam Pro",
  "Plus Jakarta Sans", "Albert Sans", "Barlow", "Titillium Web",
  "Karla", "Arimo", "Heebo", "Assistant", "Prompt",
];

const MONO_FONTS = [
  "JetBrains Mono", "SF Mono", "Fira Code", "Source Code Pro",
  "Menlo", "Monaco", "Courier New", "Cascadia Code",
  "IBM Plex Mono", "Hack", "Inconsolata", "DejaVu Sans Mono",
  "Andale Mono", "Consolas", "Ubuntu Mono",
  "Anonymous Pro", "Victor Mono", "Iosevka", "Roboto Mono",
  "Space Mono", "Noto Sans Mono", "Fantasque Sans Mono",
  "Monoid", "Droid Sans Mono", "Cousine",
  "Liberation Mono", "Fira Mono", "Oxygen Mono", "PT Mono",
  "DM Mono", "Intel One Mono", "Martian Mono", "Recursive",
  "Spline Sans Mono", "Nova Mono", "Cutive Mono",
  "Share Tech Mono", "B612 Mono", "Overpass Mono",
  "Azeret Mono", "Fragment Mono", "Geist Mono",
  "Red Hat Mono", "Lekton", "Syne Mono",
];

// All available fonts (same list for UI, terminal, and notepad)
const ALL_FONTS = [...SANS_FONTS, ...MONO_FONTS];

// CSS variable → label mapping for custom color palette
const COLOR_VARS: { key: string; label: string; group: string }[] = [
  { key: "--bg", label: "Background", group: "Base" },
  { key: "--bg2", label: "Panel BG", group: "Base" },
  { key: "--bg3", label: "Header BG", group: "Base" },
  { key: "--fg", label: "Text", group: "Text" },
  { key: "--fg2", label: "Dim Text", group: "Text" },
  { key: "--fg3", label: "Faded Text", group: "Text" },
  { key: "--bd", label: "Border", group: "Base" },
  { key: "--hover", label: "Hover", group: "Base" },
  { key: "--ac", label: "Accent", group: "Accent" },
  { key: "--ac2", label: "Accent 2", group: "Accent" },
  { key: "--red", label: "Red", group: "Status" },
  { key: "--grn", label: "Green", group: "Status" },
  { key: "--ylw", label: "Yellow", group: "Status" },
];

const PRESET_THEMES: { name: string; colors: Record<string, string> }[] = [
  { name: "GitHub Dark", colors: { "--bg":"#0d1117","--bg2":"#161b22","--bg3":"#21262d","--hover":"#30363d","--fg":"#c9d1d9","--fg2":"#8b949e","--fg3":"#6e7681","--bd":"#30363d","--ac":"#58a6ff","--ac2":"#79c0ff","--red":"#ff7b72","--grn":"#3fb950","--ylw":"#d29922" }},
  { name: "Dracula", colors: { "--bg":"#282a36","--bg2":"#343746","--bg3":"#44475a","--hover":"#6272a4","--fg":"#f8f8f2","--fg2":"#bfbfbf","--fg3":"#6272a4","--bd":"#44475a","--ac":"#bd93f9","--ac2":"#ff79c6","--red":"#ff5555","--grn":"#50fa7b","--ylw":"#f1fa8c" }},
  { name: "Solarized Dark", colors: { "--bg":"#002b36","--bg2":"#073642","--bg3":"#073642","--hover":"#586e75","--fg":"#839496","--fg2":"#657b83","--fg3":"#586e75","--bd":"#073642","--ac":"#268bd2","--ac2":"#2aa198","--red":"#dc322f","--grn":"#859900","--ylw":"#b58900" }},
  { name: "Monokai", colors: { "--bg":"#272822","--bg2":"#3e3d32","--bg3":"#49483e","--hover":"#75715e","--fg":"#f8f8f2","--fg2":"#a6a68a","--fg3":"#75715e","--bd":"#49483e","--ac":"#a6e22e","--ac2":"#66d9ef","--red":"#f92672","--grn":"#a6e22e","--ylw":"#e6db74" }},
  { name: "Nord", colors: { "--bg":"#2e3440","--bg2":"#3b4252","--bg3":"#434c5e","--hover":"#4c566a","--fg":"#eceff4","--fg2":"#d8dee9","--fg3":"#4c566a","--bd":"#434c5e","--ac":"#88c0d0","--ac2":"#81a1c1","--red":"#bf616a","--grn":"#a3be8c","--ylw":"#ebcb8b" }},
  { name: "Tokyo Night", colors: { "--bg":"#1a1b26","--bg2":"#24283b","--bg3":"#414868","--hover":"#565f89","--fg":"#c0caf5","--fg2":"#a9b1d6","--fg3":"#565f89","--bd":"#414868","--ac":"#7aa2f7","--ac2":"#bb9af7","--red":"#f7768e","--grn":"#9ece6a","--ylw":"#e0af68" }},
];

function FontSelector({ label, value, fonts, onChange }: {
  label: string; value: string; fonts: string[]; onChange: (font: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = value.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  return (
    <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4, cursor: "default" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>{label}</span>
        <span className="font-selector-trigger" onClick={() => setOpen(!open)} title="Click to choose font">
          {current} {open ? "▲" : "▼"}
        </span>
      </div>
      {open && (
        <div className="font-selector-dropdown">
          {fonts.map(f => (
            <div key={f} className={`font-selector-item${f === current ? " selected" : ""}`}
              onClick={() => { onChange(f); setOpen(false); }}>
              <span style={{ fontFamily: f, fontSize: 13 }}>{f}</span>
              {f === current && <span style={{ color: "var(--ac)", fontSize: 10 }}>✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SettingsModal({ settings, onUpdate, onClose, onResetDefaults }: Props) {
  const set = (k: keyof AppSettings, v: boolean | number | string) => onUpdate({ ...settings, [k]: v });

  const handleClearKnownHosts = async () => {
    const ok = await ask(
      "Clear all saved host keys? You will be asked to trust servers again on next connect.",
      { title: "Weterm", kind: "warning" },
    );
    if (!ok) return;
    try {
      await invoke("clear_known_hosts");
      showToast("Host keys cleared", "info");
    } catch (e) {
      showToast(String(e));
    }
  };

  // Two-click safety for reset
  const [resetConfirming, setResetConfirming] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleResetClick = useCallback(() => {
    if (resetConfirming) {
      // Second click — execute
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      setResetConfirming(false);
      onResetDefaults();
    } else {
      // First click — ask for confirmation
      setResetConfirming(true);
      resetTimerRef.current = setTimeout(() => setResetConfirming(false), 3000);
    }
  }, [resetConfirming, onResetDefaults]);

  // Parse current custom colors
  const [customColors, setCustomColors] = useState<Record<string, string>>(() => {
    if (settings.customColors) {
      try { return JSON.parse(settings.customColors); } catch { return {}; }
    }
    // Initialize from current CSS variable values (read from document)
    const init: Record<string, string> = {};
    for (const v of COLOR_VARS) {
      const val = getComputedStyle(document.documentElement).getPropertyValue(v.key).trim();
      if (val) init[v.key] = val;
    }
    return init;
  });

  const updateCustomColor = (key: string, color: string) => {
    const next = { ...customColors, [key]: color };
    setCustomColors(next);
    set("customColors", JSON.stringify(next));
    document.documentElement.style.setProperty(key, color);
  };

  const applyPreset = (preset: typeof PRESET_THEMES[0]) => {
    setCustomColors({ ...preset.colors });
    set("customColors", JSON.stringify(preset.colors));
    for (const [key, val] of Object.entries(preset.colors)) {
      document.documentElement.style.setProperty(key, val);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          {/* Right Panel */}
          <fieldset className="settings-group">
            <legend>Right Panel</legend>
            <label className="settings-row">
              <input type="checkbox" checked={settings.showCommandsTab} onChange={e => set("showCommandsTab", e.target.checked)} />
              <span>Show Commands panel</span>
            </label>
            <label className="settings-row">
              <input type="checkbox" checked={settings.showTasksTab} onChange={e => set("showTasksTab", e.target.checked)} />
              <span>Show Tasks panel</span>
            </label>
            <label className="settings-row">
              <input type="checkbox" checked={settings.showNotepadTab} onChange={e => set("showNotepadTab", e.target.checked)} />
              <span>Show Notepad panel</span>
            </label>
{/* Monitor panel temporarily disabled (perf) */}
            {/* <label className="settings-row">
              <input type="checkbox" checked={!!settings.showMonitorTab} onChange={e => set("showMonitorTab", e.target.checked)} />
              <span>Show Monitor panel</span>
            </label> */}
            <div className="settings-row"><span>Notepad save path</span>
              <input type="text" className="settings-num" style={{width:200}} value={settings.notepadSavePath} onChange={e => set("notepadSavePath", e.target.value)} /></div>
            <div className="settings-row"><span>Record save path</span>
              <input type="text" className="settings-num" style={{width:200}} value={settings.activitySavePath} onChange={e => set("activitySavePath", e.target.value)} /></div>
            <div className="settings-row"><span>Max saved entries</span>
              <input type="number" className="settings-num" min={100} max={100000} step={100} value={settings.maxSavedEntries} onChange={e => set("maxSavedEntries", Math.max(100, Number(e.target.value)))} /></div>
            <div className="settings-row"><span>Display in window</span>
              <input type="number" className="settings-num" min={5} max={500} step={5} value={settings.maxDisplayEntries} onChange={e => set("maxDisplayEntries", Math.max(5, Number(e.target.value)))} /></div>
          </fieldset>

          {/* Theme */}
          <fieldset className="settings-group">
            <legend>Theme</legend>
            <div className="settings-row">
              <span>Color theme</span>
              <select className="settings-num" style={{width:130}} value={settings.theme}
                onChange={e => {
                  set("theme", e.target.value);
                  if (e.target.value !== "custom") {
                    document.documentElement.setAttribute("data-theme", e.target.value === "system"
                      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
                      : e.target.value);
                  }
                }}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">Follow System</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className="settings-row">
              <span>Terminal background</span>
              <input type="color" value={settings.terminalBgColor || "#000000"}
                onChange={e => set("terminalBgColor", e.target.value)}
                style={{ width: 28, height: 22, padding: 0, border: "1px solid var(--bd)", borderRadius: 3, cursor: "pointer", background: "none" }}
                title="Terminal background color (default: pure black)" />
            </div>
            <div className="settings-row">
              <span>Terminal text</span>
              <input type="color" value={settings.terminalFgColor || "#f5f5f7"}
                onChange={e => set("terminalFgColor", e.target.value)}
                style={{ width: 28, height: 22, padding: 0, border: "1px solid var(--bd)", borderRadius: 3, cursor: "pointer", background: "none" }}
                title="Terminal text/foreground color (default: near-white)" />
            </div>

            {settings.theme === "custom" && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--fg2)", marginBottom: 6 }}>Preset Palettes</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
                  {PRESET_THEMES.map(p => (
                    <button key={p.name} className="btn btn-sm"
                      onClick={() => applyPreset(p)} title={`Apply ${p.name} palette`}>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 4, background: p.colors["--ac"] }} />
                      {p.name}
                    </button>
                  ))}
                </div>

                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--fg2)", marginBottom: 6 }}>Custom Colors</div>
                {["Base", "Text", "Accent", "Status"].map(group => (
                  <div key={group} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 9, color: "var(--fg3)", textTransform: "uppercase", marginBottom: 3 }}>{group}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {COLOR_VARS.filter(v => v.group === group).map(v => (
                        <div key={v.key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input type="color" value={customColors[v.key] || "#000"}
                            onChange={e => updateCustomColor(v.key, e.target.value)}
                            style={{ width: 20, height: 20, padding: 0, border: "1px solid var(--bd)", borderRadius: 3, cursor: "pointer", background: "none" }}
                            title={v.label} />
                          <span style={{ fontSize: 9, color: "var(--fg3)", width: 36, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </fieldset>

          {/* Fonts */}
          <fieldset className="settings-group">
            <legend>Fonts</legend>
            <FontSelector label="UI Font" value={settings.uiFontFamily || settings.fontFamily || ALL_FONTS[0]} fonts={ALL_FONTS} onChange={f => set("uiFontFamily", f)} />
            <div className="settings-row"><span>UI font size</span>
              <input type="number" className="settings-num" min={10} max={24} step={1} value={settings.uiFontSize} onChange={e => set("uiFontSize", Number(e.target.value))} /></div>
            <div style={{ height: 8, borderBottom: "1px solid var(--bd)", margin: "4px 0" }} />
            <FontSelector label="Terminal Font" value={settings.terminalFontFamily || ALL_FONTS[0]} fonts={ALL_FONTS} onChange={f => set("terminalFontFamily", f)} />
            <div className="settings-row"><span>Terminal font size</span>
              <input type="number" className="settings-num" min={8} max={32} step={1} value={settings.terminalFontSize} onChange={e => set("terminalFontSize", Number(e.target.value))} /></div>
            <div style={{ height: 8, borderBottom: "1px solid var(--bd)", margin: "4px 0" }} />
            <FontSelector label="Notepad Font" value={settings.notepadFontFamily || ALL_FONTS[0]} fonts={ALL_FONTS} onChange={f => set("notepadFontFamily", f)} />
            <div className="settings-row"><span>Notepad font size</span>
              <input type="number" className="settings-num" min={8} max={24} step={1} value={settings.notepadFontSize} onChange={e => set("notepadFontSize", Number(e.target.value))} /></div>
            <button className="btn btn-sm" style={{ marginTop: 8 }} title="Restore Apple system default fonts and sizes"
              onClick={() => {
                onUpdate({
                  ...settings,
                  uiFontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
                  terminalFontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
                  notepadFontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
                  uiFontSize: 13,
                  terminalFontSize: 13,
                  notepadFontSize: 11,
                });
              }}
            >↺ Reset Fonts to Defaults</button>
          </fieldset>

          {/* Status Bar */}
          <fieldset className="settings-group">
            <legend>Status Bar</legend>
            <div className="settings-row">
              <span>CPU/MEM style</span>
              <div className="seg">
                <button
                  className={`seg-btn${settings.statusStyle === "text" ? " active" : ""}`}
                  onClick={() => set("statusStyle", "text")}
                  title="Show CPU and memory as text"
                >Text</button>
                <button
                  className={`seg-btn${settings.statusStyle === "circles" ? " active" : ""}`}
                  onClick={() => set("statusStyle", "circles")}
                  title="Show CPU and memory as circular gauges"
                >Circles</button>
              </div>
            </div>
            <label className="settings-row"><input type="checkbox" checked={settings.showCpu} onChange={e => set("showCpu", e.target.checked)} /><span>Show CPU usage</span></label>
            <label className="settings-row"><input type="checkbox" checked={settings.showMem} onChange={e => set("showMem", e.target.checked)} /><span>Show memory usage</span></label>
            <label className="settings-row"><input type="checkbox" checked={settings.showLoginTime} onChange={e => set("showLoginTime", e.target.checked)} /><span>Show login time</span></label>
            <label className="settings-row"><input type="checkbox" checked={settings.showDuration} onChange={e => set("showDuration", e.target.checked)} /><span>Show connection duration</span></label>
          </fieldset>

          {/* File Display */}
          <fieldset className="settings-group">
            <legend>File Browser Columns</legend>
            <label className="settings-row"><input type="checkbox" checked={settings.showFilePermissions} onChange={e => set("showFilePermissions", e.target.checked)} /><span>Show permissions (e.g. drwxr-xr-x)</span></label>
            <label className="settings-row"><input type="checkbox" checked={settings.showFileOwner} onChange={e => set("showFileOwner", e.target.checked)} /><span>Show owner/group</span></label>
            <label className="settings-row"><input type="checkbox" checked={settings.showFileModified} onChange={e => set("showFileModified", e.target.checked)} /><span>Show modified date</span></label>
            <label className="settings-row"><input type="checkbox" checked={settings.showFileSize} onChange={e => set("showFileSize", e.target.checked)} /><span>Show file size</span></label>
          </fieldset>

          {/* Security */}
          <fieldset className="settings-group">
            <legend>Security</legend>
            <div className="settings-row">
              <span>Saved host keys</span>
              <button className="btn btn-sm" onClick={handleClearKnownHosts}>Clear Keys</button>
            </div>
          </fieldset>

          {/* ── Reset ── */}
          <div style={{ padding: "8px 0", borderTop: "1px solid var(--bd)", textAlign: "center" }}>
            <button className={`btn btn-sm ${resetConfirming ? "btn-danger" : ""}`}
              onClick={handleResetClick}
              title={resetConfirming ? "Click again to confirm reset" : "Restore all settings to their original default values"}
              style={resetConfirming ? { fontWeight: 700, animation: "pulse 0.8s ease-in-out infinite" } : undefined}
            >{resetConfirming ? "⚠ Click again to confirm reset" : "↺ Reset All Settings to Defaults"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
