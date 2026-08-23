import Foundation

/// A live editing session for one open Markdown file. Holds the last-saved text
/// alongside the in-progress text so dirty state and unsaved-changes prompts
/// work, mirroring the `filesData` map in `src/App.tsx`.
@MainActor
final class DocumentSession: ObservableObject, Identifiable {
    let path: String
    var url: URL { URL(fileURLWithPath: path) }
    nonisolated var id: String { path }
    var name: String { url.lastPathComponent }

    /// Current editor content.
    @Published var text: String
    /// Content as of the last successful save/load.
    @Published private(set) var savedText: String
    /// Non-nil when the file couldn't be read.
    @Published var loadError: String?

    var isDirty: Bool { text != savedText }

    init(path: String, text: String, loadError: String? = nil) {
        self.path = path
        self.text = text
        self.savedText = text
        self.loadError = loadError
    }

    /// Load a session from disk. Never throws — a read failure is surfaced via
    /// `loadError` so the view can show a friendly message (binary file, etc.).
    static func load(path: String) -> DocumentSession {
        do {
            let text = try FileService.read(URL(fileURLWithPath: path))
            return DocumentSession(path: path, text: text)
        } catch {
            return DocumentSession(path: path, text: "", loadError: error.localizedDescription)
        }
    }

    /// Persist current text; on success, `savedText` catches up so `isDirty`
    /// clears.
    func save() throws {
        try FileService.write(url, text)
        savedText = text
    }
}
