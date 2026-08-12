import { isTauri } from "@tauri-apps/api/core";
import type { StorageBackend } from "./types";
import { tauriBackend } from "./tauriBackend";
import { mobileBackend } from "./mobileBackend";
import { webBackend } from "./web";

// Pick the backend for the current runtime:
//  - Tauri desktop  -> local filesystem via Tauri commands (terminal + updater)
//  - Tauri mobile   -> sandbox/document-picker backend (no terminal/updater)
//  - plain web/PWA  -> composite of the connected cloud providers (Dropbox/GitHub)
const runningInTauri = isTauri();
const runningOnMobile =
  runningInTauri && /android|iphone|ipad|ipod/i.test(navigator.userAgent);

export const storage: StorageBackend = !runningInTauri
  ? webBackend
  : runningOnMobile
    ? mobileBackend
    : tauriBackend;

export * from "./types";
