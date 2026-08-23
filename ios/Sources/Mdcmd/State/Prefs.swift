import Foundation

/// Small typed wrapper over `UserDefaults` for the app's persisted preferences —
/// the native equivalent of the web build's `localStorage` keys in
/// `src/App.tsx` (pinned shortcuts, open tabs, view settings).
enum Prefs {
    private static let defaults = UserDefaults.standard

    enum Key {
        static let shortcuts = "mdcmd.shortcuts"
        static let openPaths = "mdcmd.openPaths"
        static let selectedPath = "mdcmd.selectedPath"
        static let editorFontSize = "mdcmd.editorFontSize"
    }

    // MARK: JSON codables

    static func shortcuts() -> [PinnedItem] {
        decode([PinnedItem].self, forKey: Key.shortcuts) ?? []
    }

    static func setShortcuts(_ items: [PinnedItem]) {
        encode(items, forKey: Key.shortcuts)
    }

    static func openPaths() -> [String] {
        decode([String].self, forKey: Key.openPaths) ?? []
    }

    static func setOpenPaths(_ paths: [String]) {
        encode(paths, forKey: Key.openPaths)
    }

    // MARK: Scalars

    static var selectedPath: String? {
        get { defaults.string(forKey: Key.selectedPath) }
        set { defaults.set(newValue, forKey: Key.selectedPath) }
    }

    static var editorFontSize: Double {
        get {
            let v = defaults.double(forKey: Key.editorFontSize)
            return v == 0 ? 17 : v
        }
        set { defaults.set(newValue, forKey: Key.editorFontSize) }
    }

    // MARK: Helpers

    private static func decode<T: Decodable>(_ type: T.Type, forKey key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private static func encode<T: Encodable>(_ value: T, forKey key: String) {
        if let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: key)
        }
    }
}

/// Shared storage for the Quick Note widget. The main app writes the current
/// target (path + display name) here; the widget reads it to render and to build
/// its deep link. Uses an App Group when the entitlement is present, else falls
/// back to standard defaults so the app still works un-provisioned.
enum QuickNoteShare {
    static let appGroup = "group.com.mdcmd.ios"
    static let pathKey = "quicknote.path"
    static let nameKey = "quicknote.name"

    static let store: UserDefaults = UserDefaults(suiteName: appGroup) ?? .standard

    static func read() -> (path: String, name: String)? {
        guard let path = store.string(forKey: pathKey) else { return nil }
        let name = store.string(forKey: nameKey) ?? URL(fileURLWithPath: path).lastPathComponent
        return (path, name)
    }

    static func write(path: String?, name: String?) {
        store.set(path, forKey: pathKey)
        store.set(name, forKey: nameKey)
    }
}
