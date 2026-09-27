import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { FileEntry, PathStat, PinnedItem, StorageBackend } from "./types";

// Desktop backend: thin wrapper over the existing Tauri commands.
export const tauriBackend: StorageBackend = {
  id: "tauri",
  capabilities: {
    terminal: true,
    updater: true,
    requiresAuth: false,
    documentPicker: false,
  },

  getHomeDir() {
    return invoke<string>("get_home_dir");
  },
  listDirectory(path: string) {
    return invoke<FileEntry[]>("list_directory", { path });
  },
  readFile(path: string) {
    return invoke<string>("read_file_content", { path });
  },
  writeFile(path: string, content: string) {
    return invoke("write_file_content", { path, content }).then(() => undefined);
  },
  createFile(path: string) {
    return invoke("create_file", { path }).then(() => undefined);
  },
  createFolder(path: string) {
    return invoke("create_folder", { path }).then(() => undefined);
  },
  searchDirectory(path: string, query: string) {
    return invoke<FileEntry[]>("search_directory", { path, query });
  },
  readWorkspaces() {
    return invoke<PinnedItem[]>("read_workspaces");
  },
  writeWorkspaces(items: PinnedItem[]) {
    return invoke("write_workspaces", { workspaces: items }).then(() => undefined);
  },
  statPaths(paths: string[]) {
    return invoke<(PathStat | null)[]>("path_stats", { paths });
  },
  async getMediaUrl(path: string) {
    return convertFileSrc(path);
  },
  readQuickNoteTarget() {
    return invoke<string | null>("read_quick_note_target");
  },
  writeQuickNoteTarget(path: string | null) {
    return invoke("write_quick_note_target", { path }).then(() => undefined);
  },
};
