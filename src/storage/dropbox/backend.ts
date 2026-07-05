import type { FileEntry, PinnedItem, StorageBackend } from "../types";
import { dropboxAuth } from "./auth";

const RPC_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";

// Web workspaces are UI state; persist them locally (desktop shares via config file).
const WORKSPACES_KEY = "mdcmd-dropbox-workspaces";

// Dropbox uses "" for the root; the UI uses "/". Map between them.
function toDbxPath(path: string): string {
  if (!path || path === "/") return "";
  return path.startsWith("/") ? path : `/${path}`;
}

// Dropbox-API-Arg headers must be ASCII; escape any non-ASCII characters.
function headerSafeJson(value: unknown): string {
  const json = JSON.stringify(value);
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code > 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : json[i];
  }
  return out;
}

async function authHeader(): Promise<string> {
  const token = await dropboxAuth.getAccessToken();
  return `Bearer ${token}`;
}

async function rpc<T>(endpoint: string, arg: unknown): Promise<T> {
  const res = await fetch(`${RPC_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: await authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(arg),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dropbox ${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

interface DbxEntry {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_display?: string;
  path_lower?: string;
}

function mapEntry(e: DbxEntry): FileEntry {
  return {
    name: e.name,
    path: e.path_display ?? e.path_lower ?? `/${e.name}`,
    is_dir: e[".tag"] === "folder",
  };
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1;
    if (!a.is_dir && b.is_dir) return 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export const dropboxBackend: StorageBackend = {
  id: "dropbox",
  capabilities: {
    terminal: false,
    updater: false,
    requiresAuth: true,
  },

  async getHomeDir() {
    return "/";
  },

  async listDirectory(path: string) {
    interface ListResult {
      entries: DbxEntry[];
      cursor: string;
      has_more: boolean;
    }
    let result = await rpc<ListResult>("/files/list_folder", {
      path: toDbxPath(path),
      recursive: false,
    });
    const entries = [...result.entries];
    while (result.has_more) {
      result = await rpc<ListResult>("/files/list_folder/continue", {
        cursor: result.cursor,
      });
      entries.push(...result.entries);
    }
    return sortEntries(
      entries.filter((e) => e[".tag"] !== "deleted" && !e.name.startsWith(".")).map(mapEntry)
    );
  },

  async readFile(path: string) {
    const res = await fetch(`${CONTENT_BASE}/files/download`, {
      method: "POST",
      headers: {
        Authorization: await authHeader(),
        "Dropbox-API-Arg": headerSafeJson({ path: toDbxPath(path) }),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dropbox download failed (${res.status}): ${text}`);
    }
    return res.text();
  },

  async writeFile(path: string, content: string) {
    const res = await fetch(`${CONTENT_BASE}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: await authHeader(),
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": headerSafeJson({
          path: toDbxPath(path),
          mode: "overwrite",
          mute: true,
        }),
      },
      body: content,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dropbox upload failed (${res.status}): ${text}`);
    }
  },

  async createFile(path: string) {
    const res = await fetch(`${CONTENT_BASE}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: await authHeader(),
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": headerSafeJson({
          path: toDbxPath(path),
          mode: "add",
          autorename: false,
        }),
      },
      body: "",
    });
    if (res.status === 409) {
      throw new Error(`File already exists: ${path}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dropbox create failed (${res.status}): ${text}`);
    }
  },

  async searchDirectory(path: string, query: string) {
    interface SearchResult {
      matches: { metadata: { metadata: DbxEntry } }[];
    }
    const result = await rpc<SearchResult>("/files/search_v2", {
      query,
      options: {
        path: toDbxPath(path),
        max_results: 100,
        filename_only: true,
      },
    });
    return sortEntries(
      result.matches
        .map((m) => m.metadata?.metadata)
        .filter((e): e is DbxEntry => !!e && e[".tag"] !== "deleted")
        .map(mapEntry)
    );
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

  async getMediaUrl(path: string) {
    interface TempLink {
      link: string;
    }
    const result = await rpc<TempLink>("/files/get_temporary_link", {
      path: toDbxPath(path),
    });
    return result.link;
  },
};
