# Markdown Editor & File Browser

A Markdown editor built with **Tauri v2**, **React**, **TypeScript**, and **Tiptap**. It enables browsing local files via a sidebar list and editing `.md` documents natively using a visual WYSIWYG editor that reads and saves pure Markdown.

## Key Features

- **Local File Navigation**: Traverse local folders, navigate up/down directories, and filter markdown files.
- **Tiptap Markdown Editor**: Rich-text editing with automatic Markdown serialization and deserialization.
- **Visual Formatting Toolbar**: Easy buttons to apply headers, lists, code styles, blockquotes, and undo/redo operations.
- **Save Keybindings**: Supports saving modifications natively via `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux) as well as a visual toolbar Save button.
- **Adaptable HSL Color System**: Automatically adapts to system light and dark themes with glassmorphic borders and custom scrollbars.

---

## Project Structure

- **`src-tauri/`**: The Rust backend of the Tauri application.
  - `src/lib.rs`: Exposes native Rust filesystem commands (`get_home_dir`, `list_directory`, `read_file_content`, `write_file_content`) to the webview.
  - `Cargo.toml`: Rust workspace dependencies.
- **`src/`**: The React + TypeScript frontend application.
  - `components/FileBrowser.tsx`: The folder navigation sidebar.
  - `components/MarkdownEditor.tsx`: The Tiptap rich-text editor panel.
  - `App.tsx`: Orchestrates active file loading, saving, layout panels, and landing state.
  - `index.css`: Defines CSS layout and HSL color variables.

---

## Development Workflow

### Prerequisites

Make sure you have the following installed on your machine:
1. **Node.js** (npm)
2. **Rust** and Cargo toolchain

### Installation

Install all frontend npm packages:
```bash
npm install
```

### Running in Development Mode

To start the Vite development server and open the Tauri native desktop window:
```bash
npm run tauri dev
```
Tauri will automatically rebuild the Rust code on change and reload the frontend instantly.

---

## Production Build

To compile a final release binary:

### 1. Build and Package (DMG, PKG, MSI, DEB, etc.)
```bash
npm run tauri build
```

### 2. Build Release Binary Only (Fast Compilation Check)
To build the compiled release binary without packaging it into installers:
```bash
npm run tauri build -- --no-bundle
```
The compiled release executable will be available at:
`src-tauri/target/release/tauri-app`

---

## Web Build (static site / PWA with Dropbox)

The same frontend can be built as a static, installable website (PWA) that stores
files in Dropbox instead of the local disk. Filesystem access is abstracted behind
`src/storage/`: the desktop build uses the Tauri commands, and the web build uses the
Dropbox HTTP API. The terminal and auto-updater are automatically hidden on the web.

### 1. Configure a Dropbox app

1. Create a **Scoped access** app at <https://www.dropbox.com/developers/apps>.
2. Grant the permissions `files.metadata.read`, `files.content.read`,
   `files.content.write`.
3. Under **OAuth 2 → Redirect URIs**, add every origin you serve from, e.g.
   `http://localhost:1420/` for local preview and your deployed site URL.
4. Copy the **App key** into a `.env` file (see `.env.example`):
   ```bash
   cp .env.example .env
   # then set VITE_DROPBOX_APP_KEY=<your app key>
   ```

Authentication uses OAuth 2 with PKCE, so no client secret is required or embedded.

### 2. Build and preview

```bash
npm run build:web     # outputs the static site to dist-web/
npm run preview:web   # serve dist-web/ locally at http://localhost:1420/
```

Deploy the contents of `dist-web/` to any static host. The service worker
(`public/sw.js`) and `manifest.webmanifest` make it installable on mobile and desktop.

## Mobile (native apps)

Native Android/iOS packaging via Tauri (`npm run tauri android init` /
`npm run tauri ios init`) is the planned follow-up; it requires the Android
SDK/NDK and/or Xcode toolchains to build. In the meantime the web/PWA build above
serves as the cross-platform mobile client.
