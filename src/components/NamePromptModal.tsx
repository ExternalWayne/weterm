import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  label: string;
  initialValue: string;
  confirmText?: string;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}

export default function NamePromptModal({
  title,
  label,
  initialValue,
  confirmText = "OK",
  onSubmit,
  onClose,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr("");
    try {
      await onSubmit(v);
      onClose();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: 380 }} onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="fg">
          <label>{label}</label>
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        {err && <div className="error">{err}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-sm" onClick={submit} disabled={busy || !value.trim()}>
            {busy ? "Working..." : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
