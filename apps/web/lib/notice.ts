// Tiny app-wide notice bus: anything can show a one-line message in the header bar.
type Listener = (text: string) => void;
const listeners = new Set<Listener>();

export function showNotice(text: string): void {
  listeners.forEach((l) => l(text));
}

export function onNotice(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
