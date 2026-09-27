import { useEffect, useRef, type MutableRefObject } from "react";
import { storage, type PathStat } from "../storage";

/** How often the polled paths are stat'd, in milliseconds. */
export const DISK_POLL_INTERVAL_MS = 2000;

/**
 * A compact stand-in for "the version of this path currently on disk".
 * Comparing mtime *and* size catches writes a coarse mtime alone would miss.
 * Paths that don't exist get a distinct marker of their own.
 */
export function pathSignature(stat: PathStat | null | undefined): string {
  return stat ? `${stat.mtimeMs}:${stat.size}` : "missing";
}

/**
 * Record what `path` looks like on disk right now, so `useDiskChanges` treats
 * it as already seen. Callers do this whenever they read or write a path
 * themselves, so their own changes aren't reported back to them. Best-effort:
 * a backend without `statPaths` records nothing (and is never polled).
 */
export async function recordPathSignature(
  signatures: MutableRefObject<Record<string, string>>,
  path: string,
) {
  if (!storage.statPaths) return;
  try {
    const [stat] = await storage.statPaths([path]);
    signatures.current[path] = pathSignature(stat);
  } catch {
    // Leave any previous signature in place; the next poll re-checks anyway.
  }
}

/**
 * Poll `paths` and report each one whose on-disk signature no longer matches
 * the one recorded in `signatures`, so the app can pick up files and folders
 * changed behind its back.
 *
 * The caller owns `signatures`: it records a path's signature whenever it
 * reads or writes that path itself (see `recordDiskSignature` in `App`), and
 * this hook records the new one right before reporting a change, so each
 * change is reported once. A path with no recorded signature is reported too,
 * since nothing is known about it yet — callbacks are expected to compare the
 * actual contents/listing and do nothing when it turns out to match.
 *
 * Does nothing on backends without `statPaths` (the cloud providers, where
 * polling would burn API calls) or while the window is hidden.
 */
export function useDiskChanges(
  paths: string[],
  signatures: MutableRefObject<Record<string, string>>,
  onChanged: (path: string, stat: PathStat | null) => void,
  intervalMs: number = DISK_POLL_INTERVAL_MS,
) {
  // Held in a ref so a fresh callback (it closes over current state) doesn't
  // restart the interval and reset its phase on every render.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // Same for the path list: only its contents matter, not its identity.
  const key = paths.join("\n");

  useEffect(() => {
    const statPaths = storage.statPaths?.bind(storage);
    if (!statPaths || paths.length === 0) return;

    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      let stats: (PathStat | null)[];
      try {
        stats = await statPaths(paths);
      } catch {
        return; // transient (e.g. a folder that just went away) — try again next tick
      }
      if (cancelled) return;
      paths.forEach((path, index) => {
        const stat = stats[index] ?? null;
        const signature = pathSignature(stat);
        if (signatures.current[path] === signature) return;
        signatures.current[path] = signature;
        onChangedRef.current(path, stat);
      });
    };

    const timer = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs]);
}
