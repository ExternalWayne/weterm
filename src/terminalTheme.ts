/** Read CSS custom properties from the document and build an xterm.js theme object.
 *  This keeps terminal colors in sync with the app theme (including custom themes).
 *  Pass customBg / customFg to override the terminal background/foreground independently. */
export function getTerminalTheme(customBg?: string, customFg?: string): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  const bg = customBg || s.getPropertyValue("--bg").trim() || "#1c1c1e";
  const fg = customFg || s.getPropertyValue("--fg").trim() || "#f5f5f7";
  const fg2 = s.getPropertyValue("--fg2").trim() || "#a1a1a6";
  const fg3 = s.getPropertyValue("--fg3").trim() || "#6e6e73";
  const ac = s.getPropertyValue("--ac").trim() || "#0a84ff";
  const ac2 = s.getPropertyValue("--ac2").trim() || "#5ac8fa";
  const red = s.getPropertyValue("--red").trim() || "#ff453a";
  const grn = s.getPropertyValue("--grn").trim() || "#30d158";
  const ylw = s.getPropertyValue("--ylw").trim() || "#ff9f0a";

  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    selectionBackground: ac + "44",
    black: fg3,
    red: red,
    green: grn,
    yellow: ylw,
    blue: ac,
    magenta: "#bf5af2",
    cyan: "#5ac8fa",
    white: fg2,
    brightBlack: fg3,
    brightRed: red,
    brightGreen: grn,
    brightYellow: ylw,
    brightBlue: ac2,
    brightMagenta: "#da8fff",
    brightCyan: "#64d2ff",
    brightWhite: fg,
  };
}
