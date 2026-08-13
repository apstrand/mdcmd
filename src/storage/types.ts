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
  /**
   * Whether a native folder picker is available (iOS document picker). When
   * true, the backend implements `pickFolder`/`restoreAccess`/`releaseFolder`.
   */
  documentPicker: boolean;
}

/** A folder the user granted access to via the native document picker. */
export interface PickedFolder {
  path: string;
  name: string;
}

/**
 * An authentication provider for a web backend (Dropbox, GitHub). Both use a
 * full-page OAuth redirect, so the flow is: `login()` navigates away, and on
 * return `handleRedirectCallback()` completes the exchange. Only meaningful for
 * backends whose `capabilities.requiresAuth` is true.
 */
export interface AuthProvider {
  readonly id: "dropbox" | "github";
  /** Whether the required build-time config (app key / client id) is present. */
  readonly isConfigured: boolean;
  /** Whether a usable token is currently stored. */
  readonly isAuthenticated: boolean;
  /** Begin the login flow by redirecting to the provider's consent screen. */
  login(): Promise<void>;
  /**
   * If the current URL is this provider's OAuth redirect, complete the token
   * exchange. Returns true if a login was completed. Safe to call on load.
   */
  handleRedirectCallback(): Promise<boolean>;
  /** Forget the stored token. */
  logout(): void;
}

export interface StorageBackend {
  readonly id: "tauri" | "dropbox" | "github" | "web";
  readonly capabilities: StorageCapabilities;

  /** Root/starting directory to show on first load. */
  getHomeDir(): Promise<string>;
  listDirectory(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Create a new empty file; rejects if it already exists. */
  createFile(path: string): Promise<void>;
  /** Create a new empty folder; rejects if it already exists. */
  createFolder(path: string): Promise<void>;
  searchDirectory(path: string, query: string): Promise<FileEntry[]>;
  readWorkspaces(): Promise<PinnedItem[]>;
  writeWorkspaces(items: PinnedItem[]): Promise<void>;
  /** Resolve a URL usable in <img>/<video> src for the given media file. */
  getMediaUrl(path: string): Promise<string>;

  /**
   * Present the native folder picker (iOS). Resolves to the picked folder, or
   * `null` if the user cancels. Only present when `capabilities.documentPicker`.
   */
  pickFolder?(): Promise<PickedFolder | null>;
  /**
   * Re-activate saved folder bookmarks so previously-picked folders are readable
   * again after an app relaunch. Returns the paths now accessible. Call before
   * the first directory listing on startup.
   */
  restoreAccess?(): Promise<string[]>;
  /** Release access to (and forget) a previously-picked folder (on unpin). */
  releaseFolder?(path: string): Promise<void>;
}
