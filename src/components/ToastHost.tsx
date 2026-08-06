import { useSyncExternalStore } from "react";
import { clearToast, toastStore } from "../toastStore";

export default function ToastHost() {
  const toast = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot);
  if (!toast) return null;
  return (
    <div
      className={`toast toast-${toast.kind}`}
      onClick={clearToast}
      title="Click to dismiss"
    >
      {toast.message}
    </div>
  );
}
