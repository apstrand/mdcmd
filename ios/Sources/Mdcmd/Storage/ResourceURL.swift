import Foundation

/// A tiny abstraction that lets one persisted string identify a resource in
/// either storage backend the app now speaks:
///
///   - **local** files/folders — plain filesystem paths (`/var/…/note.md`),
///     reached via `FileManager` under a security-scoped bookmark.
///   - **GitHub** — resources modelled as URLs `github:///owner/repo/sub/file.md`.
///     The empty authority (triple slash) keeps `url.path` equal to the web
///     backend's `/owner/repo/…` string, so `lastPathComponent`, `pathExtension`
///     and `appendingPathComponent` all behave, and a `FileEntry` (just a `url`
///     plus `isDirectory`) works unchanged for GitHub entries.
///
/// `storageID` is the canonical string used as the key for open documents, the
/// tab list, `Route.document`, and `FileEntry.id`. For GitHub it's the full URL
/// string (so a repo path can't collide with a same-named local path); for files
/// it's the filesystem path, matching everything that persisted paths before.

/// The root of the GitHub tree: lists the distinct owners of your repos.
let githubRoot = URL(string: "github:///")!

extension URL {
    /// Whether this URL addresses a GitHub resource rather than a local file.
    var isGitHub: Bool { scheme == "github" }

    /// The canonical, round-trippable identifier for this resource.
    var storageID: String { isGitHub ? absoluteString : path }
}

/// Rebuild a resource URL from a `storageID` produced above.
func resourceURL(_ id: String) -> URL {
    if id.hasPrefix("github:") {
        return URL(string: id) ?? URL(fileURLWithPath: id)
    }
    return URL(fileURLWithPath: id)
}
