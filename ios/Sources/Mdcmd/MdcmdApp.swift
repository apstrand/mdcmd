import SwiftUI

@main
struct MdcmdApp: App {
    @StateObject private var app = AppState()

    var body: some Scene {
        WindowGroup {
            BrowserView()
                .environmentObject(app)
                .task {
                    // Re-activate security-scoped bookmarks for previously-picked
                    // folders/files before anything tries to list them.
                    app.restoreAccess()
                }
                .onOpenURL { handleOpen($0) }
        }
    }

    /// Handle inbound URLs: a file URL from the system "Open With" / share sheet
    /// (opened in place), or the Quick Note widget's `mdcmd://quicknote` deep
    /// link.
    private func handleOpen(_ url: URL) {
        if url.isFileURL {
            BookmarkStore.activate(url)
            app.reveal(path: url.resolvingSymlinksInPath().path, focusAtEnd: true)
        } else if url.scheme == "mdcmd", url.host == "quicknote" {
            if let target = app.quickNoteTarget {
                app.reveal(path: target, focusAtEnd: true)
            }
        }
    }
}
