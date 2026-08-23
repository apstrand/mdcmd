import Foundation

/// The pre-pinned welcome note, seeded into "On My iPhone" on first launch. It
/// doubles as a feature tour and — because it's real Markdown opened in the
/// editor — a live demo of the syntax highlighting and preview.
enum WelcomeDocument {
    static let fileName = "Welcome to MarkDown Commander.md"

    static let content = """
    # Welcome to MarkDown Commander 👋

    A native Markdown editor for the files you already have — on your iPhone, \
    in iCloud Drive, Dropbox, Google Drive, and anywhere the Files app reaches.

    ## Getting started

    - Tap the **＋** button (top right) to add a **folder** or **file** from \
    Files, iCloud Drive, Dropbox, or Google Drive.
    - This note lives in **On My iPhone** — a built-in local space. Anything you \
    keep there also appears in the Files app under *On My iPhone › MarkDown Commander*.
    - **Pin** folders and files as shortcuts so they're always one tap away.

    ## Writing

    This is the editor. Type Markdown and it styles as you go:

    - **bold**, _italic_, ~~strikethrough~~
    - `inline code`, and fenced blocks:

    ```swift
    let greeting = "Hello, Markdown!"
    ```

    Lists and checklists work too:

    - [x] Read the welcome note
    - [ ] Add one of your own folders

    > Tip: switch between **Edit** and **Preview** using the toggle at the top.

    ### Formatting bar

    While editing, the bar above the keyboard adds headings, bold, italic, code, \
    lists, checkboxes, and links.

    ## A few more things

    - **Open in place** — open `.md` files from other apps and edit the original.
    - **Media** — view images and videos right alongside your notes.
    - Everything stays in *your* files. Nothing is locked away.

    Happy writing!
    """
}
