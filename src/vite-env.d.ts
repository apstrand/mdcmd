/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DROPBOX_APP_KEY?: string;
  readonly VITE_GITHUB_CLIENT_ID?: string;
  readonly VITE_GITHUB_OAUTH_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
