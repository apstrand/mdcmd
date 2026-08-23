import Foundation

/// Value-based navigation targets pushed onto the browser's `NavigationStack`.
enum Route: Hashable {
    case folder(URL)
    case document(String)
    case media(FileEntry)
    /// A read-only "What you can do" help page, rendered as Markdown.
    case info(TourTopic)

    /// The destination for opening a file-system entry.
    init(_ entry: FileEntry) {
        switch entry.kind {
        case .folder: self = .folder(entry.url)
        case .image, .video: self = .media(entry)
        case .text: self = .document(entry.url.path)
        }
    }
}
