/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DROPBOX_APP_KEY?: string;
  readonly VITE_GITHUB_CLIENT_ID?: string;
  readonly VITE_GITHUB_OAUTH_PROXY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Ships without its own type declarations; it's a plain markdown-it plugin.
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}
