# mdc — MarkDown Commander (TUI)

**mdc** is a terminal file browser and Markdown viewer for the command line. It
gives you a fast, keyboard-driven way to navigate local folders, preview `.md`
documents with syntax-styled rendering, pin frequently used workspaces, and hand
files off to your `$EDITOR` or the system's default GUI application.

It is the companion terminal UI to the [mdcmd](https://mdcmd.com) desktop
Markdown editor, built with [ratatui](https://ratatui.rs) and
[crossterm](https://github.com/crossterm-rs/crossterm).

## Features

- **Local file navigation** — browse folders in either a flat **List** or an
  expandable **Tree** view, move up and down the directory hierarchy, and filter
  entries as you type.
- **Markdown preview** — render `.md` files directly in the terminal with styled
  headings, code blocks, and inline formatting. Media files are recognized too.
- **Tabs** — open multiple files at once and cycle between them.
- **Pinned workspaces** — pin folders or files and jump straight to them; pins
  persist across sessions.
- **Editor & GUI hand-off** — open a file in your `$EDITOR` (defaults to `nano`),
  or launch it in the host's default GUI application.
- **Terminal & clipboard** — drop into a shell in the current directory, or copy
  the selected file's path or name to the clipboard.
- **Adaptive colors** — automatically detects light/dark terminal themes, with
  manual overrides via environment variables.

## Installation

Install from [crates.io](https://crates.io/crates/mdc) with Cargo:

```bash
cargo install mdc
```

This builds and installs the `mdc` binary into `~/.cargo/bin`. Make sure that
directory is on your `PATH`.

### Build from source

```bash
git clone https://github.com/apstrand/mdcmd
cd mdcmd/cli
cargo install --path .
```

## Usage

Launch in the current directory:

```bash
mdc
```

Or point it at a specific folder:

```bash
mdc ~/notes
```

## Keybindings

| Key | Action |
| --- | --- |
| `Tab` / `Shift-Tab` | Cycle focus between panels |
| `[` / `]` | Cycle active tabs |
| `Ctrl-1..9` | Switch active file tab (1–9) |
| `Ctrl-Shift-1..9` | Activate pinned workspace item (1–9) |
| `j` / `k` / arrows | Navigate lists and scroll the viewer |
| `Enter` | Enter folder / expand node / open file |
| `Backspace` / `u` | Navigate to parent directory |
| `/` | Filter the current list |
| `v` | Toggle Folders view mode (Tree / List) |
| `p` | Pin/Unpin the current folder or file |
| `w` / `c` | Close the active file/tab |
| `t` | Open a terminal in the current directory |
| `n` | Create a new file in the current directory |
| `e` | Edit the selected Markdown file in `$EDITOR` |
| `o` | Open the selected file in the host default GUI app |
| `y` / `Y` | Copy selected file path / name to clipboard |
| `Esc` / `q` | Quit |

## Configuration

Pinned workspaces and the selected view mode are stored in a JSON config file
under your platform config directory:

- macOS: `~/Library/Application Support/mdcmd/config.json`
- Linux: `~/.config/mdcmd/config.json`
- Windows: `%APPDATA%\mdcmd\config.json`

### Environment variables

- `MDCMD_LIGHT_MODE` — force the light color palette.
- `MDCMD_DARK_MODE` — force the dark color palette.
- `EDITOR` — editor launched by the `e` key (defaults to `nano`).

When no override is set, `mdc` detects the terminal theme automatically (via
`COLORFGBG`, or `AppleInterfaceStyle` on macOS).

## License

MIT
