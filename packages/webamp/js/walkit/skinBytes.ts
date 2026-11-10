// The skin webamp last loaded, kept as bytes for walkit, which reads the archive itself: a
// classic .wsz, or a modern .wal only walkit can show; null for the base skin.

export type SkinBytes = { bytes: Uint8Array; modern: boolean } | null;
type Listener = (skin: SkinBytes) => void;

let latest: SkinBytes = null;
const listeners = new Set<Listener>();

export function setSkinBytes(skin: SkinBytes) {
  latest = skin;
  listeners.forEach((l) => l(skin));
}

export function getSkinBytes(): SkinBytes {
  return latest;
}

export function onSkinBytes(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Whether walkit draws the main window: on unless the page's link says `?walkit=0`. */
export function walkitEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URL(window.location.href).searchParams.get("walkit") !== "0";
}
