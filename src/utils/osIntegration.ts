import { storage } from "../storage";

const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
const isMac = /mac/i.test(navigator.userAgent) && !isMobile;
const isWindows = /win/i.test(navigator.userAgent);

/** Whether a path can be handed to the desktop's own file manager. */
export const canRevealInOS = storage.id === "tauri" && !isMobile;

/** What that file manager is called here, for menu labels. */
export const revealLabel = isMac
  ? "Reveal in Finder"
  : isWindows
    ? "Show in File Explorer"
    : "Show in file manager";

/** Select `path` in the desktop file manager (Finder, Explorer, Nautilus…). */
export async function revealInOS(path: string) {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

/** The parent directory of `path` (or `null` for a filesystem root). */
export function parentDir(path: string): string | null {
  if (!path) return null;
  const separator = path.includes("\\") ? "\\" : "/";
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = trimmed.lastIndexOf(separator);
  if (index < 0) return null;
  return index === 0 ? separator : trimmed.slice(0, index);
}
