import { isTauri } from "@tauri-apps/api/core";
import type { StorageBackend } from "./types";
import { tauriBackend } from "./tauriBackend";
import { mobileBackend } from "./mobileBackend";
import { webBackend, webAuth } from "./web";

// Pick the backend for the current runtime:
//  - Tauri desktop  -> local filesystem via Tauri commands (terminal + updater)
//  - Tauri mobile   -> sandbox/document-picker backend (no terminal/updater)
//  - plain web/PWA  -> the selected cloud provider (Dropbox or GitHub)
const runningInTauri = isTauri();
const runningOnMobile =
  runningInTauri && /android|iphone|ipad|ipod/i.test(navigator.userAgent);

export const storage: StorageBackend = !runningInTauri
  ? webBackend
  : runningOnMobile
    ? mobileBackend
    : tauriBackend;

// Auth handle is only meaningful for the web build (backends that require auth).
export const auth = runningInTauri ? null : webAuth;

export * from "./types";
