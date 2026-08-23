import Foundation

/// The app's own on-device storage — the `Documents` directory, which the Files
/// app surfaces under "On My iPhone › mdcmd" (see `UIFileSharingEnabled` +
/// `LSSupportsOpeningDocumentsInPlace` in Mdcmd-Info.plist). It's always
/// available without a security-scoped bookmark, so it's offered as a built-in
/// location alongside the user's picked shortcuts.
enum LocalStore {
    static let displayName = "My Documents"

    static var documents: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            .resolvingSymlinksInPath()
    }

    static var entry: FileEntry {
        FileEntry(url: documents, isDirectory: true)
    }

    /// Whether `url` is the local Documents root (used to label it "On My
    /// iPhone" instead of "Documents").
    static func isDocumentsRoot(_ url: URL) -> Bool {
        url.standardizedFileURL == documents.standardizedFileURL
    }
}
