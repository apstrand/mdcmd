// Dropbox OAuth 2 using PKCE (no client secret), suitable for a static SPA.
//
// Register a "Scoped access" app at https://www.dropbox.com/developers/apps with
// permissions: files.metadata.read, files.content.read, files.content.write.
// Add this site's origin (e.g. https://example.com/ or http://localhost:1420/)
// to the app's OAuth 2 redirect URIs, and put the app key in VITE_DROPBOX_APP_KEY.

const APP_KEY = import.meta.env.VITE_DROPBOX_APP_KEY as string | undefined;

const TOKEN_ENDPOINT = "https://api.dropboxapi.com/oauth2/token";
const AUTHORIZE_ENDPOINT = "https://www.dropbox.com/oauth2/authorize";

const STORAGE_KEY = "mdcmd-dropbox-token";
const VERIFIER_KEY = "mdcmd-dropbox-pkce-verifier";

interface StoredToken {
  accessToken: string;
  refreshToken: string | null;
  // epoch ms when the access token expires
  expiresAt: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function challengeFromVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function redirectUri(): string {
  // Strip any query/hash so it matches the registered redirect URI exactly.
  return window.location.origin + window.location.pathname;
}

class DropboxAuth {
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
    return !!APP_KEY;
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

  /** Begin the login flow by redirecting to Dropbox's consent screen. */
  async login(): Promise<void> {
    if (!APP_KEY) throw new Error("VITE_DROPBOX_APP_KEY is not set");
    const verifier = randomVerifier();
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    const challenge = await challengeFromVerifier(verifier);

    const params = new URLSearchParams({
      client_id: APP_KEY,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: redirectUri(),
      token_access_type: "offline",
    });
    window.location.href = `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
  }

  /**
   * If the current URL is an OAuth redirect (has ?code=), exchange it for tokens.
   * Returns true if a login was completed. Safe to call on every page load.
   */
  async handleRedirectCallback(): Promise<boolean> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return false;

    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    if (!verifier || !APP_KEY) return false;

    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      code_verifier: verifier,
      client_id: APP_KEY,
      redirect_uri: redirectUri(),
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new Error(`Dropbox token exchange failed: ${res.status}`);
    const data = await res.json();
    this.token = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: Date.now() + (data.expires_in ?? 14400) * 1000,
    };
    this.persist();

    // Clean the ?code=... out of the address bar.
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, document.title, url.pathname + url.search);
    return true;
  }

  logout() {
    this.token = null;
    this.persist();
  }

  /** Return a valid access token, refreshing it if it is about to expire. */
  async getAccessToken(): Promise<string> {
    if (!this.token) throw new Error("Not authenticated with Dropbox");
    // Refresh a minute before actual expiry.
    if (Date.now() < this.token.expiresAt - 60_000) {
      return this.token.accessToken;
    }
    if (!this.token.refreshToken || !APP_KEY) {
      // Can't refresh; force re-auth.
      this.logout();
      throw new Error("Dropbox session expired, please reconnect");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.token.refreshToken,
      client_id: APP_KEY,
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      this.logout();
      throw new Error("Dropbox token refresh failed, please reconnect");
    }
    const data = await res.json();
    this.token = {
      accessToken: data.access_token,
      refreshToken: this.token.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 14400) * 1000,
    };
    this.persist();
    return this.token.accessToken;
  }
}

export const dropboxAuth = new DropboxAuth();
