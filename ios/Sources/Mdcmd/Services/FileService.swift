import Foundation

/// Filesystem operations for the browser and editor. The Swift-native
/// equivalent of the Tauri commands in `src-tauri/src/lib.rs`
/// (`list_directory` / `read_file_content` / `write_file_content` / …).
///
/// All work happens inside an active security scope established by
/// ``BookmarkStore`` for the enclosing picked root. Reads and writes go through
/// `NSFileCoordinator`, which is required for documents living in iCloud Drive
/// or third-party File Providers (Dropbox, Google Drive): it triggers
/// materialisation of not-yet-downloaded files and coordinates with the
/// provider's own access.
enum FileService {
    enum FileError: LocalizedError {
        case notUTF8
        case alreadyExists(String)
        case coordination(String)

        var errorDescription: String? {
            switch self {
            case .notUTF8:
                return "This file isn't valid UTF-8 text and can't be opened as Markdown."
            case .alreadyExists(let name):
                return "\"\(name)\" already exists."
            case .coordination(let msg):
                return msg
            }
        }
    }

    // MARK: Listing

    /// Directory contents, folders first then files, each group sorted by name
    /// case-insensitively. Hidden dotfiles are omitted, matching a typical
    /// Files-app presentation. GitHub URLs are served over the network; local
    /// file URLs go straight through `FileManager`.
    static func list(_ directory: URL) async throws -> [FileEntry] {
        if directory.isGitHub { return try await GitHubService.shared.list(directory) }
        return try listLocal(directory)
    }

    private static func listLocal(_ directory: URL) throws -> [FileEntry] {
        let urls = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles])

        let entries = urls.map { url -> FileEntry in
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            return FileEntry(url: url.resolvingSymlinksInPath(), isDirectory: isDir)
        }

        return entries.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    // MARK: Reading / writing

    static func read(_ url: URL) async throws -> String {
        if url.isGitHub { return try await GitHubService.shared.read(url) }
        return try readLocal(url)
    }

    /// Synchronous local read, used for the no-flash initial load of on-device
    /// documents (GitHub documents load asynchronously via `read`).
    static func readLocal(_ url: URL) throws -> String {
        var coordinatorError: NSError?
        var readError: Error?
        var result: String?

        NSFileCoordinator(filePresenter: nil).coordinate(
            readingItemAt: url, options: [.withoutChanges], error: &coordinatorError
        ) { readURL in
            do {
                let data = try Data(contentsOf: readURL)
                guard let text = String(data: data, encoding: .utf8) else {
                    readError = FileError.notUTF8
                    return
                }
                result = text
            } catch {
                readError = error
            }
        }

        if let coordinatorError { throw FileError.coordination(coordinatorError.localizedDescription) }
        if let readError { throw readError }
        return result ?? ""
    }

    static func write(_ url: URL, _ content: String) async throws {
        if url.isGitHub { try await GitHubService.shared.write(url, content); return }
        try writeLocal(url, content)
    }

    private static func writeLocal(_ url: URL, _ content: String) throws {
        var coordinatorError: NSError?
        var writeError: Error?

        NSFileCoordinator(filePresenter: nil).coordinate(
            writingItemAt: url, options: [.forReplacing], error: &coordinatorError
        ) { writeURL in
            do {
                try content.data(using: .utf8)?.write(to: writeURL, options: .atomic)
            } catch {
                writeError = error
            }
        }

        if let coordinatorError { throw FileError.coordination(coordinatorError.localizedDescription) }
        if let writeError { throw writeError }
    }

    // MARK: Creating

    /// Create an empty file, failing if it already exists. Returns the URL.
    @discardableResult
    static func createFile(in directory: URL, named name: String) async throws -> URL {
        let url = directory.appendingPathComponent(name)
        if directory.isGitHub {
            try await GitHubService.shared.createFile(url)
            return url
        }
        if FileManager.default.fileExists(atPath: url.path) {
            throw FileError.alreadyExists(name)
        }
        try writeLocal(url, "")
        return url
    }

    /// Create an empty folder, failing if it already exists. Returns the URL.
    @discardableResult
    static func createFolder(in directory: URL, named name: String) async throws -> URL {
        let url = directory.appendingPathComponent(name, isDirectory: true)
        if directory.isGitHub {
            try await GitHubService.shared.createFolder(url)
            return url
        }
        if FileManager.default.fileExists(atPath: url.path) {
            throw FileError.alreadyExists(name)
        }
        try FileManager.default.createDirectory(
            at: url, withIntermediateDirectories: false)
        return url
    }

    // MARK: Search

    /// Recursively find entries under `root` whose name contains `query`
    /// (case-insensitive). Capped to keep large trees responsive. GitHub uses the
    /// code-search API (scoped to the enclosing repo).
    static func search(root: URL, query: String, limit: Int = 200) async -> [FileEntry] {
        if root.isGitHub {
            return (try? await GitHubService.shared.search(root, query: query)) ?? []
        }
        return searchLocal(root: root, query: query, limit: limit)
    }

    private static func searchLocal(root: URL, query: String, limit: Int) -> [FileEntry] {
        let needle = query.lowercased()
        guard !needle.isEmpty else { return [] }

        var results: [FileEntry] = []
        let keys: [URLResourceKey] = [.isDirectoryKey]
        guard
            let enumerator = FileManager.default.enumerator(
                at: root, includingPropertiesForKeys: keys,
                options: [.skipsHiddenFiles])
        else { return [] }

        for case let url as URL in enumerator {
            if results.count >= limit { break }
            if url.lastPathComponent.lowercased().contains(needle) {
                let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
                results.append(FileEntry(url: url.resolvingSymlinksInPath(), isDirectory: isDir))
            }
        }

        return results.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }
}
