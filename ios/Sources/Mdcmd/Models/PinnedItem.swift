import Foundation

/// A pinned shortcut — a folder or file the user reached through the system
/// document picker (Files / iCloud Drive / Dropbox / Google Drive) and pinned
/// for quick access. Mirrors the `PinnedItem` shape in `src/storage/types.ts`.
///
/// `path` is the file-system path; access is backed by a security-scoped
/// bookmark in ``BookmarkStore``, re-activated on each launch.
struct PinnedItem: Identifiable, Codable, Hashable {
    let path: String
    let isDir: Bool

    var id: String { path }
    var url: URL { URL(fileURLWithPath: path) }
    var name: String { url.lastPathComponent }
}
