// GitHub OAuth for a static SPA.
//
// GitHub's token exchange requires the client *secret*, which cannot live in
// static frontend code, so the code->token step is delegated to a small
// serverless proxy (see server/github-oauth-worker/). The browser only ever
// holds the OAuth client id and the resulting access token.
//
// Register an OAuth App at https://github.com/settings/developers with the
// site's URL as the "Authorization callback URL", then set:
//   VITE_GITHUB_CLIENT_ID    the OAuth App's client id
//   VITE_GITHUB_OAUTH_PROXY  the proxy endpoint that performs the token exchange

import type { AuthProvider } from "../types";

const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined;
const OAUTH_PROXY = import.meta.env.VITE_GITHUB_OAUTH_PROXY as string | undefined;

const AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
// `repo` grants read/write to private and public repository contents. Use
// `public_repo` instead if only public repositories should be reachable.
const SCOPE = "repo";

const STORAGE_KEY = "mdcmd-github-token";
const STATE_KEY = "mdcmd-github-oauth-state";

interface StoredToken {
  accessToken: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function redirectUri(): string {
  // Strip any query/hash so it matches the registered callback URL exactly.
  return window.location.origin + window.location.pathname;
}

class GitHubAuth implements AuthProvider {
  readonly id = "github" as const;
  private token: StoredToken | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.token = JSON.parse(raw);
    } catch {
      this.token = null;
    }
  }

  get isConfigured(): boolean {
    return !!CLIENT_ID && !!OAUTH_PROXY;
  }

  get isAuthenticated(): boolean {
    return !!this.token;
  }

  private persist() {
    if (this.token) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.token));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  async login(): Promise<void> {
    if (!CLIENT_ID) throw new Error("VITE_GITHUB_CLIENT_ID is not set");
    const state = randomState();
    // Persist the CSRF state in localStorage (not sessionStorage): a top-level
    // cross-origin redirect to github.com and back can drop sessionStorage in
    // some browsers, which would strand the callback with no state to match.
    localStorage.setItem(STATE_KEY, state);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri(),
      scope: SCOPE,
      state,
    });
    window.location.href = `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
  }

  // Deduplicate the exchange within a single page load. React StrictMode runs
  // effects twice in dev, and an auth code is single-use, so both invocations
  // must share one in-flight exchange (and one result). Reset naturally on the
  // next full page load, which is when the OAuth redirect returns.
  private exchange: Promise<boolean> | null = null;

  handleRedirectCallback(): Promise<boolean> {
    if (!this.exchange) this.exchange = this.doExchange();
    return this.exchange;
  }

  private async doExchange(): Promise<boolean> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    // Not a callback URL — nothing to do (and don't touch the address bar).
    if (!code) return false;

    const expected = localStorage.getItem(STATE_KEY);
    localStorage.removeItem(STATE_KEY);
    try {
      if (!expected || state !== expected) {
        throw new Error(
          "GitHub sign-in could not be verified (state mismatch). Click Connect GitHub to try again.",
        );
      }
      if (!OAUTH_PROXY) throw new Error("VITE_GITHUB_OAUTH_PROXY is not set");

      const res = await fetch(OAUTH_PROXY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, redirect_uri: redirectUri() }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub token exchange failed (${res.status}): ${text}`);
      }
      const data = await res.json();
      if (data.error || !data.access_token) {
        throw new Error(`GitHub token exchange failed: ${data.error ?? "no token"}`);
      }
      this.token = { accessToken: data.access_token };
      this.persist();
      return true;
    } finally {
      // Strip ?code/?state either way, so a refresh doesn't reprocess a code
      // that's already been spent (each is single-use).
      url.searchParams.delete("code");
      url.searchParams.delete("state");
      window.history.replaceState({}, document.title, url.pathname + url.search);
    }
  }

  logout() {
    this.token = null;
    this.persist();
  }

  /** Return the stored access token, or throw if not authenticated. */
  getAccessToken(): string {
    if (!this.token) throw new Error("Not authenticated with GitHub");
    return this.token.accessToken;
  }
}

export const githubAuth = new GitHubAuth();
