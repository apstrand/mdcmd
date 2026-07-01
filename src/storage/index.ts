import { isTauri } from "@tauri-apps/api/core";
import type { StorageBackend } from "./types";
import { tauriBackend } from "./tauriBackend";
import { dropboxBackend } from "./dropbox/backend";
import { dropboxAuth } from "./dropbox/auth";

// Pick the backend for the current runtime: the Tauri commands on the desktop,
// the Dropbox HTTP API when running as a plain website / PWA.
const runningInTauri = isTauri();

export const storage: StorageBackend = runningInTauri ? tauriBackend : dropboxBackend;

// Auth handle is only meaningful for backends that require authentication.
export const auth = runningInTauri ? null : dropboxAuth;

export * from "./types";
