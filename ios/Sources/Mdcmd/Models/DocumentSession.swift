import Foundation

/// A live editing session for one open Markdown file. Holds the last-saved text
/// alongside the in-progress text so dirty state and unsaved-changes prompts
/// work, mirroring the `filesData` map in `src/App.tsx`.
@MainActor
final class DocumentSession: ObservableObject, Identifiable {
    let path: String
    var url: URL { resourceURL(path) }
    nonisolated var id: String { path }
    var name: String { url.lastPathComponent }

    /// Current editor content.
    @Published var text: String
    /// Content as of the last successful save/load.
    @Published private(set) var savedText: String
    /// Non-nil when the file couldn't be read.
    @Published var loadError: String?
    /// True while the initial content is still being fetched (GitHub only — local
    /// files load synchronously, so they're never in this state).
    @Published private(set) var isLoading: Bool

    var isDirty: Bool { text != savedText }

    init(path: String, text: String, loadError: String? = nil, isLoading: Bool = false) {
        self.path = path
        self.text = text
        self.savedText = text
        self.loadError = loadError
        self.isLoading = isLoading
    }

    /// Create a session for a path. Local files are read synchronously (no empty
    /// flash); GitHub documents come back empty + loading and fetch themselves in
    /// the background. A read failure is surfaced via `loadError` so the view can
    /// show a friendly message (binary file, etc.) rather than throwing.
    static func load(path: String) -> DocumentSession {
        let url = resourceURL(path)
        if url.isGitHub {
            let session = DocumentSession(path: path, text: "", isLoading: true)
            Task { await session.reload() }
            return session
        }
        do {
            let text = try FileService.readLocal(url)
            return DocumentSession(path: path, text: text)
        } catch {
            return DocumentSession(path: path, text: "", loadError: error.localizedDescription)
        }
    }

    /// Fetch (or re-fetch) content from the backend. Used for the async GitHub
    /// initial load.
    func reload() async {
        isLoading = true
        do {
            let text = try await FileService.read(url)
            self.text = text
            self.savedText = text
            self.loadError = nil
        } catch {
            self.loadError = error.localizedDescription
        }
        isLoading = false
    }

    /// Persist current text; on success, `savedText` catches up so `isDirty`
    /// clears.
    func save() async throws {
        try await FileService.write(url, text)
        savedText = text
    }
}
