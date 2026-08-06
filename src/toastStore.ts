export interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
}

type Listener = () => void;

let current: Toast | null = null;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(l => l());
}

export function showToast(message: string, kind: "error" | "info" = "error") {
  current = { id: Date.now(), kind, message };
  notify();
}

export function clearToast() {
  current = null;
  notify();
}

export const toastStore = {
  getSnapshot(): Toast | null {
    return current;
  },
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
