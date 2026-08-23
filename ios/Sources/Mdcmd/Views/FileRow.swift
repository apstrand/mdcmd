import SwiftUI

/// One row in a directory or shortcuts listing, with a leading kind icon and a
/// trailing pin indicator. Pinning, Quick Note, and (for folders reached via the
/// picker) removal are offered via swipe actions and a context menu — the native
/// equivalents of the hover buttons in `src/components/FileBrowser.tsx`.
struct FileRow: View {
    let entry: FileEntry
    /// Optional path shown under the name (used in search results).
    var subtitle: String? = nil
    @EnvironmentObject private var app: AppState

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: entry.kind.systemImage)
                .foregroundStyle(entry.isDirectory ? Color.accentColor : Color.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.name).lineLimit(1)
                if let subtitle {
                    Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if app.isPinned(entry.path) {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(Color.accentColor)
            }
        }
        .contentShape(Rectangle())
        .swipeActions(edge: .trailing) {
            Button {
                app.togglePin(entry.path, isDir: entry.isDirectory)
            } label: {
                Label(app.isPinned(entry.path) ? "Unpin" : "Pin",
                      systemImage: app.isPinned(entry.path) ? "pin.slash" : "pin")
            }
            .tint(.accentColor)
        }
        .contextMenu {
            Button {
                app.togglePin(entry.path, isDir: entry.isDirectory)
            } label: {
                Label(app.isPinned(entry.path) ? "Unpin" : "Pin to Shortcuts",
                      systemImage: app.isPinned(entry.path) ? "pin.slash" : "pin")
            }
        }
    }
}

private extension FileEntry {
    var path: String { url.path }
}
