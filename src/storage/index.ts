import { isTauri } from "@tauri-apps/api/core";
import type { StorageBackend } from "./types";
import { tauriBackend } from "./tauriBackend";
import { mobileBackend } from "./mobileBackend";
import { dropboxBackend } from "./dropbox/backend";
import { dropboxAuth } from "./dropbox/auth";

// Pick the backend for the current runtime:
//  - Tauri desktop  -> local filesystem via Tauri commands (terminal + updater)
//  - Tauri mobile   -> sandbox/document-picker backend (no terminal/updater)
//  - plain web/PWA  -> Dropbox HTTP API
const runningInTauri = isTauri();
const runningOnMobile =
  runningInTauri && /android|iphone|ipad|ipod/i.test(navigator.userAgent);

export const storage: StorageBackend = !runningInTauri
  ? dropboxBackend
  : runningOnMobile
    ? mobileBackend
    : tauriBackend;

// Auth handle is only meaningful for backends that require authentication.
export const auth = runningInTauri ? null : dropboxAuth;

export * from "./types";
