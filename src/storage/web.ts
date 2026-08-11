// Web build: the user connects one of several cloud providers (Dropbox,
// GitHub). Which one is active is remembered across the OAuth redirect (and
// subsequent sessions) in localStorage. The desktop/mobile builds never touch
// this module.

import type { AuthProvider, StorageBackend } from "./types";
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

// Order here is the order shown on the connect screen.
export const webProviders: WebProvider[] = [
  { id: "dropbox", label: "Dropbox", auth: dropboxAuth, backend: dropboxBackend },
  { id: "github", label: "GitHub", auth: githubAuth, backend: githubBackend },
];

const PROVIDER_KEY = "mdcmd-web-provider";

export function getSelectedProviderId(): WebProviderId | null {
  const raw = localStorage.getItem(PROVIDER_KEY);
  return raw === "dropbox" || raw === "github" ? raw : null;
}

/**
 * Remember which provider the user is connecting with. Called just before
 * `login()` so that, after the OAuth redirect returns, we know which provider's
 * callback to run and which backend to use.
 */
export function setSelectedProviderId(id: WebProviderId): void {
  localStorage.setItem(PROVIDER_KEY, id);
}

function selectedProvider(): WebProvider {
  const id = getSelectedProviderId();
  return webProviders.find((p) => p.id === id) ?? webProviders[0];
}

/** The backend for the currently-selected web provider (defaults to the first). */
export const webBackend: StorageBackend = selectedProvider().backend;

/** The auth handle for the currently-selected web provider. */
export const webAuth: AuthProvider = selectedProvider().auth;
