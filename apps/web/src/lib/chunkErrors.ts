/**
 * After an update the old hashed page chunks are gone, so a tab left open fails when it next
 * opens a lazy page. The wording varies by browser; these cover Chromium, Firefox and Safari.
 */
const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_ERROR.test(error.message);
}

const RELOAD_KEY = "talorys.chunkReloadAt";
const RELOAD_WINDOW_MS = 60_000;

/** True at most once a minute, so a chunk that stays missing can't cause a reload loop. Records the attempt. */
export function shouldAutoReload(storage: Pick<Storage, "getItem" | "setItem">, now = Date.now()): boolean {
  try {
    const last = Number(storage.getItem(RELOAD_KEY));
    if (last && now - last < RELOAD_WINDOW_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

/** Reloads to pick up the new version, unless that was just tried. Returns whether it reloaded. */
export function reloadForNewVersion(): boolean {
  let storage: Storage;
  try {
    storage = sessionStorage;
  } catch {
    return false;
  }
  if (!shouldAutoReload(storage)) return false;
  location.reload();
  return true;
}
