import Foundation
import SwiftUI

/// Single source of truth for navigation-independent app state: pinned
/// shortcuts, the set of open documents (with their live edit sessions), and the
/// Quick Note target. The native counterpart of the top-level state in
/// `src/App.tsx`.
@MainActor
final class AppState: ObservableObject {
    /// Pinned folders/files, persisted and shared conceptually with the desktop
    /// "workspaces". Folders are browsable roots; files open directly.
    @Published var shortcuts: [PinnedItem] {
        didSet { Prefs.setShortcuts(shortcuts) }
    }

    /// Paths of currently-open documents, in open order (the tab strip).
    @Published private(set) var openPaths: [String] {
        didSet { Prefs.setOpenPaths(openPaths) }
    }

    /// The file the Quick Note widget jumps into (nil if unset).
    @Published var quickNoteTarget: String?

    /// iPhone (compact) navigation stack: folders, documents, and media all push
    /// here. Held here (not persisted) so deep links — "Open With", the Quick
    /// Note widget — can push onto it from anywhere.
    @Published var navPath: [Route] = []

    /// iPad (regular) split view: the sidebar's folder-drill stack…
    @Published var browsePath: [URL] = []
    /// …and the document/media shown in the detail column.
    @Published var detailSelection: Route?

    /// Whether the two-column split layout is active (set by the browser from the
    /// horizontal size class). Governs whether opening routes to the split
    /// columns or the single stack.
    var isSplit = false

    /// A one-shot: the document that should focus at end after opening (set when
    /// jumping in via Quick Note / open-with). `DocumentView` consumes it.
    @Published var focusAtEndPath: String?

    /// Live edit sessions, keyed by path, so dirty state survives switching
    /// between open documents.
    private var sessions: [String: DocumentSession] = [:]

    init() {
        self.shortcuts = Prefs.shortcuts()
        self.openPaths = Prefs.openPaths()
        self.quickNoteTarget = QuickNoteShare.read()?.path
        seedWelcomeIfNeeded()
    }

    // MARK: Launch

    /// Re-activate security-scoped bookmarks for previously-picked folders/files.
    /// Call before the first directory listing. Returns paths now accessible.
    @discardableResult
    func restoreAccess() -> [String] {
        BookmarkStore.restoreAll()
    }

    // MARK: Shortcuts

    func isPinned(_ path: String) -> Bool {
        shortcuts.contains { $0.path == path }
    }

    func pin(_ path: String, isDir: Bool) {
        guard !isPinned(path) else { return }
        shortcuts.append(PinnedItem(path: path, isDir: isDir))
    }

    func unpin(_ path: String) {
        shortcuts.removeAll { $0.path == path }
        // Releasing a picked root also drops its security-scoped bookmark.
        BookmarkStore.release(path)
        if quickNoteTarget == path { setQuickNoteTarget(nil) }
    }

    func togglePin(_ path: String, isDir: Bool) {
        if isPinned(path) { unpin(path) } else { pin(path, isDir: isDir) }
    }

    /// Shortcuts sorted files-first then by path, matching the sidebar order in
    /// `src/App.tsx` (`sortedPinned`).
    var sortedShortcuts: [PinnedItem] {
        shortcuts.sorted { a, b in
            if a.isDir != b.isDir { return !a.isDir }
            return a.path.localizedCaseInsensitiveCompare(b.path) == .orderedAscending
        }
    }

    // MARK: Open documents

    /// The session for a path, loading it from disk and registering it as open
    /// on first request.
    func session(for path: String) -> DocumentSession {
        if let existing = sessions[path] { return existing }
        let session = DocumentSession.load(path: path)
        sessions[path] = session
        if !openPaths.contains(path) { openPaths.append(path) }
        Prefs.selectedPath = path
        return session
    }

    /// Peek at an already-open session without loading (for dirty indicators).
    func existingSession(for path: String) -> DocumentSession? {
        sessions[path]
    }

    func closeDocument(_ path: String) {
        sessions.removeValue(forKey: path)
        openPaths.removeAll { $0 == path }
        if Prefs.selectedPath == path { Prefs.selectedPath = openPaths.last }
    }

    var hasDirtyDocuments: Bool {
        sessions.values.contains { $0.isDirty }
    }

    func saveAll() {
        for session in sessions.values where session.isDirty {
            try? session.save()
        }
    }

    // MARK: Navigation

    /// Open an entry from a list. Folders drill into the browser; documents and
    /// media open in the detail column on iPad, or push on iPhone.
    func open(_ entry: FileEntry) {
        if entry.kind == .folder {
            if isSplit { browsePath.append(entry.url) } else { navPath.append(.folder(entry.url)) }
        } else {
            let route = Route(entry)
            if isSplit { detailSelection = route } else { navPath.append(route) }
        }
    }

    /// Show a "What you can do" help page (Markdown preview). Routes to the
    /// detail column on iPad, or pushes on iPhone.
    func showInfo(_ topic: TourTopic) {
        let route = Route.info(topic)
        if isSplit { detailSelection = route } else { navPath.append(route) }
    }

    /// Open a path delivered by a deep link (Quick Note widget / "Open With").
    /// Resolves whether it's a folder, media, or text document and navigates to
    /// it from the root.
    func reveal(path: String, focusAtEnd: Bool = false) {
        let url = URL(fileURLWithPath: path)
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: path, isDirectory: &isDir)

        if isDir.boolValue {
            if isSplit { browsePath = [url] } else { navPath = [.folder(url)] }
            return
        }

        let route = Route(FileEntry(url: url, isDirectory: false))
        if case .document = route, focusAtEnd { focusAtEndPath = path }
        if isSplit {
            detailSelection = route
        } else {
            navPath = [route]
        }
    }

    // MARK: First-run welcome

    /// On first launch, write the welcome note into "On My iPhone" and pin it, so
    /// there's something to open immediately (and a live demo of the editor). A
    /// flag ensures it's only ever seeded once — deleting or unpinning it sticks.
    private func seedWelcomeIfNeeded() {
        let key = "mdcmd.didSeedWelcome"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)

        let url = LocalStore.documents.appendingPathComponent(WelcomeDocument.fileName)
        do {
            if !FileManager.default.fileExists(atPath: url.path) {
                try WelcomeDocument.content.data(using: .utf8)?.write(to: url, options: .atomic)
            }
            pin(url.path, isDir: false)
        } catch {
            NSLog("Failed to seed welcome note: \(error.localizedDescription)")
        }
    }

    // MARK: Quick Note

    func setQuickNoteTarget(_ path: String?) {
        quickNoteTarget = path
        let name = path.map { URL(fileURLWithPath: $0).lastPathComponent }
        QuickNoteShare.write(path: path, name: name)
    }
}
