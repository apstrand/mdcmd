import { invoke } from "@tauri-apps/api/core";
import type { PickedFolder, StorageBackend } from "./types";
import { tauriBackend } from "./tauriBackend";

// The native folder picker is implemented for iOS only (UIDocumentPicker +
// security-scoped bookmarks). Android Storage Access Framework is a follow-up.
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

// Mobile (iOS/Android) backend. It reuses the Tauri file commands but advertises
// no terminal and no auto-updater, so those parts of the UI stay hidden. On iOS
// it also exposes the native document picker, which grants access to folders in
// iCloud Drive / the Files app; once access is active, the same file commands
// read and write inside those folders.
export const mobileBackend: StorageBackend = {
  ...tauriBackend,
  id: "tauri",
  capabilities: {
    terminal: false,
    updater: false,
    requiresAuth: false,
    documentPicker: isIOS,
  },

  pickFolder() {
    return invoke<PickedFolder | null>("plugin:docpicker|pick_folder");
  },
  restoreAccess() {
    return invoke<string[]>("plugin:docpicker|restore_access");
  },
  releaseFolder(path: string) {
    return invoke("plugin:docpicker|release_folder", { path }).then(
      () => undefined,
    );
  },
};
