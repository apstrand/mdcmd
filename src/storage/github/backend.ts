import type { FileEntry, PinnedItem, StorageBackend } from "../types";
import { githubAuth } from "./auth";

// The GitHub backend presents the whole account as one browsable tree so it can
// reuse the existing single-root file browser:
//
//   "/"                       -> the distinct owners of your repos (as folders)
//   "/owner"                  -> that owner's repositories (as folders)
//   "/owner/repo"             -> the repo root (its default branch)
//   "/owner/repo/sub/file.md" -> files/folders inside the repo
//
// All content operations act on each repo's default branch via the REST
// contents API.

const API_BASE = "https://api.github.com";

// Web workspaces (pinned repos/paths) are UI state; persist them locally.
const WORKSPACES_KEY = "mdcmd-github-workspaces";

interface RepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
}

// Repos and their default branches, fetched once per session.
let reposCache: RepoInfo[] | null = null;
const defaultBranchByFullName = new Map<string, string>();

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${githubAuth.getAccessToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

async function ghFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    // Never use the browser HTTP cache: the same contents URL is fetched both
    // as raw text (readFile) and as JSON metadata (sha lookup), and a cached
    // raw body served to the metadata request would fail to parse as JSON.
    // no-store also avoids stale listings/reads right after a commit.
    cache: "no-store",
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string>) },
  });
}

// Encode a UTF-8 string as base64 (btoa only handles Latin-1 directly).
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Split an app path into repo coordinates. */
function parsePath(p: string): {
  owner?: string;
  repo?: string;
  inRepoPath: string;
  parts: string[];
} {
  const parts = (p || "/").split("/").filter(Boolean);
  return {
    owner: parts[0],
    repo: parts[1],
    inRepoPath: parts.slice(2).join("/"),
    parts,
  };
}

async function getRepos(): Promise<RepoInfo[]> {
  if (reposCache) return reposCache;
  const repos: RepoInfo[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await ghFetch(
      `/user/repos?per_page=100&sort=full_name&page=${page}`,
    );
    if (!res.ok) {
      throw new Error(`GitHub list repos failed (${res.status}): ${await res.text()}`);
    }
    const batch = (await res.json()) as Array<{
      name: string;
      owner: { login: string };
      default_branch: string;
    }>;
    for (const r of batch) {
      const info = {
        owner: r.owner.login,
        repo: r.name,
        defaultBranch: r.default_branch,
      };
      repos.push(info);
      defaultBranchByFullName.set(`${info.owner}/${info.repo}`, info.defaultBranch);
    }
    if (batch.length < 100) break;
  }
  reposCache = repos;
  return repos;
}

async function defaultBranch(owner: string, repo: string): Promise<string> {
  const key = `${owner}/${repo}`;
  const cached = defaultBranchByFullName.get(key);
  if (cached) return cached;
  const res = await ghFetch(`/repos/${owner}/${repo}`);
  if (!res.ok) {
    throw new Error(`GitHub repo lookup failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { default_branch: string };
  defaultBranchByFullName.set(key, data.default_branch);
  return data.default_branch;
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1;
    if (!a.is_dir && b.is_dir) return 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

interface ContentEntry {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  sha: string;
}

export const githubBackend: StorageBackend = {
  id: "github",
  capabilities: {
    terminal: false,
    updater: false,
    requiresAuth: true,
    documentPicker: false,
  },

  async getHomeDir() {
    return "/";
  },

  async listDirectory(path: string) {
    const { owner, repo, inRepoPath, parts } = parsePath(path);

    // Root: list the distinct owners of your repos as folders.
    if (parts.length === 0) {
      const owners = [...new Set((await getRepos()).map((r) => r.owner))];
      return sortEntries(
        owners.map((o) => ({ name: o, path: `/${o}`, is_dir: true })),
      );
    }

    // "/owner": list that owner's repositories as folders.
    if (parts.length === 1) {
      const repos = (await getRepos()).filter((r) => r.owner === owner);
      return sortEntries(
        repos.map((r) => ({
          name: r.repo,
          path: `/${r.owner}/${r.repo}`,
          is_dir: true,
        })),
      );
    }

    // Inside a repo: list the contents at this path on the default branch.
    const branch = await defaultBranch(owner!, repo!);
    const res = await ghFetch(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(inRepoPath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`,
    );
    if (!res.ok) {
      throw new Error(`GitHub list failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as ContentEntry[] | ContentEntry;
    const items = Array.isArray(data) ? data : [data];
    return sortEntries(
      items
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: `/${owner}/${repo}/${e.path}`,
          is_dir: e.type === "dir",
        })),
    );
  },

  async readFile(path: string) {
    const { owner, repo, inRepoPath } = parsePath(path);
    if (!owner || !repo || !inRepoPath) throw new Error(`Not a file: ${path}`);
    const branch = await defaultBranch(owner, repo);
    const res = await ghFetch(
      `/repos/${owner}/${repo}/contents/${inRepoPath}?ref=${encodeURIComponent(branch)}`,
      { headers: { Accept: "application/vnd.github.raw" } },
    );
    if (!res.ok) {
      throw new Error(`GitHub download failed (${res.status}): ${await res.text()}`);
    }
    return res.text();
  },

  async writeFile(path: string, content: string) {
    const { owner, repo, inRepoPath } = parsePath(path);
    if (!owner || !repo || !inRepoPath) throw new Error(`Not a file: ${path}`);
    const branch = await defaultBranch(owner, repo);

    // Updating an existing file requires its current blob sha.
    let sha: string | undefined;
    const head = await ghFetch(
      `/repos/${owner}/${repo}/contents/${inRepoPath}?ref=${encodeURIComponent(branch)}`,
    );
    if (head.ok) {
      const meta = (await head.json()) as { sha: string };
      sha = meta.sha;
    }

    const res = await ghFetch(`/repos/${owner}/${repo}/contents/${inRepoPath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Update ${inRepoPath}`,
        content: utf8ToBase64(content),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub upload failed (${res.status}): ${await res.text()}`);
    }
  },

  async createFile(path: string) {
    const { owner, repo, inRepoPath } = parsePath(path);
    if (!owner || !repo || !inRepoPath) throw new Error(`Cannot create file here: ${path}`);
    const branch = await defaultBranch(owner, repo);

    const head = await ghFetch(
      `/repos/${owner}/${repo}/contents/${inRepoPath}?ref=${encodeURIComponent(branch)}`,
    );
    if (head.ok) throw new Error(`File already exists: ${path}`);

    const res = await ghFetch(`/repos/${owner}/${repo}/contents/${inRepoPath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Create ${inRepoPath}`,
        content: "",
        branch,
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub create failed (${res.status}): ${await res.text()}`);
    }
  },

  async searchDirectory(path: string, query: string) {
    const { owner, repo, inRepoPath } = parsePath(path);
    // Code search is only available scoped to a repository.
    if (!owner || !repo) return [];
    try {
      const q = `${query} repo:${owner}/${repo}`;
      const res = await ghFetch(
        `/search/code?per_page=100&q=${encodeURIComponent(q)}`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { items: Array<{ name: string; path: string }> };
      return sortEntries(
        data.items
          .filter((it) => !inRepoPath || it.path.startsWith(inRepoPath))
          .map((it) => ({
            name: it.name,
            path: `/${owner}/${repo}/${it.path}`,
            is_dir: false,
          })),
      );
    } catch {
      return [];
    }
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
    const { owner, repo, inRepoPath } = parsePath(path);
    if (!owner || !repo || !inRepoPath) throw new Error(`Not a file: ${path}`);
    const branch = await defaultBranch(owner, repo);
    // raw.githubusercontent.com can't carry an auth header from <img>, so fetch
    // the bytes with the token and hand back an object URL (works for private
    // repos too).
    const res = await ghFetch(
      `/repos/${owner}/${repo}/contents/${inRepoPath}?ref=${encodeURIComponent(branch)}`,
      { headers: { Accept: "application/vnd.github.raw" } },
    );
    if (!res.ok) {
      throw new Error(`GitHub media fetch failed (${res.status}): ${await res.text()}`);
    }
    return URL.createObjectURL(await res.blob());
  },
};
