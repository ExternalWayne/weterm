/// External store for transfer progress data.
/// Progress updates (written/total/speed/eta) are written here instead of
/// React state to avoid re-rendering the entire App tree on every tick.
/// Only TaskPanel subscribes via useSyncExternalStore.
export interface ProgressData {
  written: number;
  total: number;
  speed: number;
  eta: number;
}

type Listener = () => void;

let data: Record<string, ProgressData> = {};
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach(l => l());
}

export const progressStore = {
  /** Returns the current snapshot (for useSyncExternalStore). */
  getSnapshot(): Record<string, ProgressData> {
    return data;
  },

  /** Subscribe to changes. Returns unsubscribe function. */
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  /** Merge progress data for a transfer id. Notifies subscribers. */
  update(id: string, partial: ProgressData): void {
    data = { ...data, [id]: partial };
    notify();
  },

  /** Bulk-update from a batch. Single notification. */
  updateMany(updates: Record<string, ProgressData>): void {
    data = { ...data, ...updates };
    notify();
  },

  /** Remove a transfer from the store. */
  remove(id: string): void {
    if (data[id]) {
      const next = { ...data };
      delete next[id];
      data = next;
      notify();
    }
  },
};
