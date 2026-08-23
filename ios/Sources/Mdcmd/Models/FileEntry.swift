import Foundation

/// One entry in a directory listing. Mirrors the `FileEntry` shape used by the
/// web/Tauri frontend (`src/storage/types.ts`), but Swift-native around `URL`.
struct FileEntry: Identifiable, Hashable {
    let url: URL
    let isDirectory: Bool

    var id: String { url.path }
    var name: String { url.lastPathComponent }

    /// Classify by extension for iconography and routing (edit vs. media view).
    var kind: FileKind {
        if isDirectory { return .folder }
        switch url.pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "heic", "heif", "tiff":
            return .image
        case "mp4", "webm", "ogg", "mov", "mkv", "m4v":
            return .video
        default:
            return .text
        }
    }
}

enum FileKind {
    case folder, text, image, video

    var systemImage: String {
        switch self {
        case .folder: return "folder"
        case .text: return "doc.text"
        case .image: return "photo"
        case .video: return "film"
        }
    }
}
