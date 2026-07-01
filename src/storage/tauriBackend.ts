import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { FileEntry, PinnedItem, StorageBackend } from "./types";

// Desktop backend: thin wrapper over the existing Tauri commands.
export const tauriBackend: StorageBackend = {
  id: "tauri",
  capabilities: {
    terminal: true,
    updater: true,
    requiresAuth: false,
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
  searchDirectory(path: string, query: string) {
    return invoke<FileEntry[]>("search_directory", { path, query });
  },
  readWorkspaces() {
    return invoke<PinnedItem[]>("read_workspaces");
  },
  writeWorkspaces(items: PinnedItem[]) {
    return invoke("write_workspaces", { workspaces: items }).then(() => undefined);
  },
  async getMediaUrl(path: string) {
    return convertFileSrc(path);
  },
};
