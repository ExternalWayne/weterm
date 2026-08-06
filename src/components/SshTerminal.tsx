import { useEffect, useRef, forwardRef, useImperativeHandle, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import type { SessionConfig } from "../types";
import { getTerminalTheme } from "../terminalTheme";

interface Props { session: SessionConfig; onCommand?: (command: string) => void; fontSize?: number; fontFamily?: string; onFontSizeChange?: (size: number) => void; isRecording?: boolean; onRecordingData?: (data: string, type: "output" | "input") => void; terminalBgColor?: string; terminalFgColor?: string; }

export interface SshTerminalHandle {
  pasteText: (text: string) => void;
}

const SshTerminal = memo(forwardRef<SshTerminalHandle, Props>(function SshTerminal({ session, onCommand, fontSize, fontFamily, onFontSizeChange, isRecording, onRecordingData, terminalBgColor, terminalFgColor }, ref) {
  const elRef = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const cmdBuf = useRef("");
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const onFontSizeChangeRef = useRef(onFontSizeChange);
  onFontSizeChangeRef.current = onFontSizeChange;
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;
  const onRecordingDataRef = useRef(onRecordingData);
  onRecordingDataRef.current = onRecordingData;

  // Expose pasteText so parent can insert text into the terminal (e.g. double-click activity log)
  // Writes directly to PTY only — PTY echo handles display, avoiding double-render
  useImperativeHandle(ref, () => ({
    pasteText: (text: string) => {
      invoke("ssh_terminal_write", { id: session.id, data: text }).catch(() => {});
    },
  }), [session.id]);

  useEffect(() => {
    if (!elRef.current) return;
    const t = new Terminal({
      cursorBlink: true, cursorStyle: "block",
      fontSize: fontSize ?? 13, scrollback: 2000,
      allowTransparency: false,
      fontFamily: fontFamily ?? "'JetBrains Mono', 'SF Mono', monospace",
      theme: getTerminalTheme(terminalBgColor, terminalFgColor),
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(elRef.current);
    term.current = t;
    fitRef.current = fit;

    // Use onData — handles ALL keyboard input including:
    // regular keys, Enter, Backspace, Tab, arrows, Ctrl+key, paste, etc.
    // Fire-and-forget: PTY echo/output is captured by the polling loop below.
    t.onData((data) => {
      invoke("ssh_terminal_write", { id: session.id, data }).catch(() => {});

      // Recap recording: capture user input
      if (isRecordingRef.current) {
        onRecordingDataRef.current?.(data, "input");
      }

      // Capture typed commands for activity log
      const handler = onCommandRef.current;
      if (handler) {
        cmdBuf.current += data;
        if (data.includes("\r") || data.includes("\n")) {
          const parts = cmdBuf.current.split(/[\r\n]+/);
          cmdBuf.current = parts.pop() || "";
          for (const part of parts) {
            const cleaned = part.replace(/[\x00-\x1f\x7f]/g, "").trim();
            if (cleaned) handler(cleaned);
          }
        }
      }
    });

    // Notify PTY of terminal dimensions so apps like vim/top render correctly
    t.onResize(({ cols, rows }) => {
      invoke("ssh_terminal_resize", { id: session.id, cols, rows }).catch(() => {});
    });

    // Poll PTY output at 30ms intervals — handles both echo and command output.
    // Never stops on error (transient errors should not kill the poll).
    poll.current = setInterval(async () => {
      try {
        const o = await invoke<string>("ssh_terminal_read", { id: session.id });
        if (o && term.current) {
          term.current.write(o);
          // Force re-render after PTY write (fixes blank screen after vim/nano exit)
          (term.current as any).refresh?.();
          // Recap recording: capture PTY output
          if (isRecordingRef.current) {
            onRecordingDataRef.current?.(o, "output");
          }
        }
      } catch { /* keep polling — connection may recover */ }
    }, 30);

    // Initial fit + PTY resize notification
    fit.fit();
    setTimeout(() => fit.fit(), 50);
    const ro = new ResizeObserver(() => fit.fit());
    ro.observe(elRef.current);

    // Ctrl/Cmd + Scroll wheel to adjust font size — document-level capture
    // ensures we intercept before xterm.js internal handlers
    const onWheel = (e: WheelEvent) => {
      if (!elRef.current?.contains(e.target as Node)) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY > 0 ? -1 : 1;
        const newSize = Math.max(8, Math.min(32, (t.options.fontSize ?? fontSize ?? 13) + delta));
        t.options.fontSize = newSize;
        fit.fit();
        onFontSizeChangeRef.current?.(newSize);
      }
    };
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });

    return () => {
      if (poll.current) clearInterval(poll.current);
      document.removeEventListener("wheel", onWheel, { capture: true });
      ro.disconnect();
      t.dispose();
    };
  }, [session.id]);

  // Update terminal options when font settings change via Settings modal
  // (without recreating the terminal — only session change does that)
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    if (fontSize !== undefined) t.options.fontSize = fontSize;
    if (fontFamily !== undefined) t.options.fontFamily = fontFamily;
    fitRef.current?.fit();
  }, [fontSize, fontFamily]);

  // Hot-swap terminal background color without recreating the terminal
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.options.theme = getTerminalTheme(terminalBgColor, terminalFgColor);
  }, [terminalBgColor, terminalFgColor]);

  return <div ref={elRef} className="term" />;
}));

export default SshTerminal;
