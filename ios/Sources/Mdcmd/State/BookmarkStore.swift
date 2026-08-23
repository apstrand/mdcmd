import Foundation

/// Security-scoped bookmark management for folders and files reached through the
/// system document picker.
///
/// Ported from the Tauri plugin `src-tauri/plugins/docpicker/ios/Sources/
/// DocpickerPlugin.swift`. iOS only grants an app persistent access to
/// user-picked locations via bookmarks that must be re-resolved and
/// re-activated (`startAccessingSecurityScopedResource`) on every launch. Once a
/// folder's scope is active, ordinary `FileManager` calls work throughout its
/// subtree — which is what lets ``FileService`` read and write picked folders.
///
/// Bookmarks are keyed by path (matching the original plugin's UserDefaults
/// store) so pinned items, which persist paths, resolve back to live URLs.
enum BookmarkStore {
    private static let key = "docpicker.bookmarks"

    private static func load() -> [String: Data] {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: Data]) ?? [:]
    }

    private static func save(_ store: [String: Data]) {
        UserDefaults.standard.set(store, forKey: key)
    }

    /// Bookmark a freshly-picked URL. The caller must have already started its
    /// security scope (the picker delegate does). Returns the canonical path.
    @discardableResult
    static func add(_ url: URL) -> String {
        do {
            let data = try url.bookmarkData(
                options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            var store = load()
            store[url.path] = data
            save(store)
        } catch {
            NSLog("BookmarkStore.add failed: \(error.localizedDescription)")
        }
        return url.path
    }

    /// Re-resolve and re-activate every saved bookmark. Stale bookmarks are
    /// refreshed; unresolvable ones are dropped. Returns the paths now active.
    @discardableResult
    static func restoreAll() -> [String] {
        var store = load()
        var active: [String] = []
        var changed = false

        for (key, data) in store {
            var stale = false
            guard
                let url = try? URL(
                    resolvingBookmarkData: data, options: [], relativeTo: nil,
                    bookmarkDataIsStale: &stale)
            else {
                store.removeValue(forKey: key)
                changed = true
                continue
            }

            if url.startAccessingSecurityScopedResource() {
                active.append(url.path)
            }

            if stale,
                let fresh = try? url.bookmarkData(
                    options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
            {
                store[key] = fresh
                changed = true
            }
        }

        if changed { save(store) }
        return active
    }

    /// Resolve a single stored bookmark to a live URL (without changing scope
    /// state). Used to stop-accessing on release.
    private static func resolve(_ path: String) -> URL? {
        guard let data = load()[path] else { return nil }
        var stale = false
        return try? URL(
            resolvingBookmarkData: data, options: [], relativeTo: nil,
            bookmarkDataIsStale: &stale)
    }

    /// Stop accessing and forget a bookmark (on unpin).
    static func release(_ path: String) {
        if let url = resolve(path) {
            url.stopAccessingSecurityScopedResource()
        }
        var store = load()
        store.removeValue(forKey: path)
        save(store)
    }

    /// Start accessing (and bookmark) a URL delivered via "Open With" / share
    /// sheet so it can be edited in place. Mirrors the plugin's
    /// `activateAndBookmark`.
    static func activate(_ url: URL) {
        guard url.isFileURL else { return }
        _ = url.startAccessingSecurityScopedResource()
        add(url)
    }
}
