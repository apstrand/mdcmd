// Storage abstraction shared by the desktop (Tauri) and web (Dropbox) builds.

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface PinnedItem {
  path: string;
  isDir: boolean;
}

export interface StorageCapabilities {
  /** Whether an embedded terminal / "open terminal" is available (desktop only). */
  terminal: boolean;
  /** Whether the auto-updater is available (desktop only). */
  updater: boolean;
  /** Whether the backend requires the user to authenticate before use (web/Dropbox). */
  requiresAuth: boolean;
}

export interface StorageBackend {
  readonly id: "tauri" | "dropbox";
  readonly capabilities: StorageCapabilities;

  /** Root/starting directory to show on first load. */
  getHomeDir(): Promise<string>;
  listDirectory(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Create a new empty file; rejects if it already exists. */
  createFile(path: string): Promise<void>;
  searchDirectory(path: string, query: string): Promise<FileEntry[]>;
  readWorkspaces(): Promise<PinnedItem[]>;
  writeWorkspaces(items: PinnedItem[]): Promise<void>;
  /** Resolve a URL usable in <img>/<video> src for the given media file. */
  getMediaUrl(path: string): Promise<string>;
}
