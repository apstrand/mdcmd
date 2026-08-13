// Web build: several cloud providers (Dropbox, GitHub) can be connected at the
// same time. This module exposes a single composite `StorageBackend` that
// presents each connected provider as a top-level root and routes every
// operation to the right provider by a path prefix:
//
//   "/"                       -> the connected providers, as folders
//   "/dropbox/…"              -> the Dropbox backend (prefix stripped)
//   "/github/owner/repo/…"    -> the GitHub backend (prefix stripped)
//
// A provider counts as "connected" once its auth handle holds a token. Connect
// and disconnect are driven from the folder view (see FileBrowser).

import type {
  AuthProvider,
  FileEntry,
  PinnedItem,
  StorageBackend,
} from "./types";
import { dropboxBackend } from "./dropbox/backend";
import { dropboxAuth } from "./dropbox/auth";
import { githubBackend } from "./github/backend";
import { githubAuth } from "./github/auth";

export type WebProviderId = "dropbox" | "github";

interface WebProvider {
  id: WebProviderId;
  label: string;
  auth: AuthProvider;
  backend: StorageBackend;
}

// Order here is the order shown in the connect menu / at the root.
export const webProviders: WebProvider[] = [
  { id: "dropbox", label: "Dropbox", auth: dropboxAuth, backend: dropboxBackend },
  { id: "github", label: "GitHub", auth: githubAuth, backend: githubBackend },
];

// Which provider is mid-OAuth (set right before redirecting, read on return to
// route the callback to the right handler).
const PENDING_KEY = "mdcmd-web-provider";
// Composite pinned workspaces, stored with provider-prefixed paths.
const WORKSPACES_KEY = "mdcmd-web-workspaces";

export function getPendingProviderId(): WebProviderId | null {
  const raw = localStorage.getItem(PENDING_KEY);
  return raw === "dropbox" || raw === "github" ? raw : null;
}

function providerById(id: string | undefined): WebProvider | undefined {
  return webProviders.find((p) => p.id === id);
}

/** Providers with a stored token (i.e. currently browsable roots). */
export function connectedProviders(): WebProvider[] {
  return webProviders.filter((p) => p.auth.isAuthenticated);
}

/** Configured providers that are not yet connected (offered in the connect menu). */
export function connectableProviders(): { id: WebProviderId; label: string }[] {
  return webProviders
    .filter((p) => p.auth.isConfigured && !p.auth.isAuthenticated)
    .map(({ id, label }) => ({ id, label }));
}

/** Whether at least one provider is configured (so connecting is possible). */
export function anyProviderConfigured(): boolean {
  return webProviders.some((p) => p.auth.isConfigured);
}

/** Begin connecting a provider: remember it, then redirect to its consent screen. */
export function connectProvider(id: WebProviderId): Promise<void> {
  const provider = providerById(id);
  if (!provider) return Promise.reject(new Error(`Unknown provider: ${id}`));
  localStorage.setItem(PENDING_KEY, id);
  return provider.auth.login();
}

/** Forget a provider's token. The caller is responsible for refreshing the UI. */
export function disconnectProvider(id: WebProviderId): void {
  providerById(id)?.auth.logout();
}

/**
 * Complete a pending OAuth redirect, if this page load is one. Returns the id of
 * the provider that just connected, or null.
 */
export async function completePendingConnect(): Promise<WebProviderId | null> {
  const provider = providerById(getPendingProviderId() ?? undefined);
  if (!provider) return null;
  const connected = await provider.auth.handleRedirectCallback();
  return connected ? provider.id : null;
}

// --- path routing ---------------------------------------------------------

interface Routed {
  provider?: WebProvider;
  rest: string; // path within the provider's own scheme (leading "/")
}

function route(path: string): Routed {
  const parts = (path || "/").split("/").filter(Boolean);
  if (parts.length === 0) return { rest: "/" };
  return {
    provider: providerById(parts[0]),
    rest: "/" + parts.slice(1).join("/"),
  };
}

// Re-prefix a provider-scheme path back into the composite scheme.
function prefixEntry(id: WebProviderId, e: FileEntry): FileEntry {
  return { ...e, path: `/${id}${e.path}` };
}

export const webBackend: StorageBackend = {
  id: "web",
  capabilities: {
    terminal: false,
    updater: false,
    // The app always mounts; connecting happens in the folder view rather than a
    // blocking gate, so no whole-app auth requirement.
    requiresAuth: false,
    documentPicker: false,
  },

  async getHomeDir() {
    return "/";
  },

  async listDirectory(path: string) {
    const { provider, rest } = route(path);
    if (!provider) {
      // Root: the connected providers as folders.
      return connectedProviders().map((p) => ({
        name: p.label,
        path: `/${p.id}`,
        is_dir: true,
      }));
    }
    const entries = await provider.backend.listDirectory(rest);
    return entries.map((e) => prefixEntry(provider.id, e));
  },

  async readFile(path: string) {
    const { provider, rest } = route(path);
    if (!provider) throw new Error(`Not a file: ${path}`);
    return provider.backend.readFile(rest);
  },

  async writeFile(path: string, content: string) {
    const { provider, rest } = route(path);
    if (!provider) throw new Error(`Cannot write here: ${path}`);
    return provider.backend.writeFile(rest, content);
  },

  async createFile(path: string) {
    const { provider, rest } = route(path);
    if (!provider) throw new Error(`Cannot create a file here: ${path}`);
    return provider.backend.createFile(rest);
  },

  async createFolder(path: string) {
    const { provider, rest } = route(path);
    if (!provider) throw new Error(`Cannot create a folder here: ${path}`);
    return provider.backend.createFolder(rest);
  },

  async searchDirectory(path: string, query: string) {
    const { provider, rest } = route(path);
    // Searching at the root (across providers) isn't supported.
    if (!provider) return [];
    const entries = await provider.backend.searchDirectory(rest, query);
    return entries.map((e) => prefixEntry(provider.id, e));
  },

  async getMediaUrl(path: string) {
    const { provider, rest } = route(path);
    if (!provider) throw new Error(`Not a file: ${path}`);
    return provider.backend.getMediaUrl(rest);
  },

  async readWorkspaces() {
    try {
      const raw = localStorage.getItem(WORKSPACES_KEY);
      return raw ? (JSON.parse(raw) as PinnedItem[]) : [];
    } catch {
      return [];
    }
  },

  async writeWorkspaces(items: PinnedItem[]) {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(items));
  },
};
