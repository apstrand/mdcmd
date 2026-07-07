import type { StorageBackend } from "./types";
import { tauriBackend } from "./tauriBackend";

// Mobile (iOS/Android) backend. It reuses the Tauri file commands but advertises
// no terminal and no auto-updater, so those parts of the UI stay hidden. File
// access is rooted in the app's sandbox for now; a follow-up wires the native
// document pickers (UIDocumentPickerViewController / Storage Access Framework)
// so the user can reach iCloud Drive, Google Drive and the Files app.
export const mobileBackend: StorageBackend = {
  ...tauriBackend,
  id: "tauri",
  capabilities: {
    terminal: false,
    updater: false,
    requiresAuth: false,
  },
};
