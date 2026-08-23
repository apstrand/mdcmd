import SwiftUI

/// Contents of one folder. Drilling into a subfolder pushes another `FolderView`,
/// so "back" is "up" and navigation stays within the picked, security-scoped
/// root. Supports recursive search and new file/folder creation, mirroring the
/// folder pane of `src/components/FileBrowser.tsx`.
struct FolderView: View {
    let folder: URL
    @EnvironmentObject private var app: AppState

    @State private var entries: [FileEntry] = []
    @State private var loadError: String?
    @State private var searchText = ""
    @State private var creating: CreateKind?
    @State private var newName = ""
    @State private var actionError: String?

    private enum CreateKind: Identifiable {
        case file, folder
        var id: Int { hashValue }
        var title: String { self == .file ? "New File" : "New Folder" }
        var placeholder: String { self == .file ? "note.md" : "folder name" }
    }

    private var visible: [FileEntry] {
        let q = searchText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return entries }
        return FileService.search(root: folder, query: q)
    }

    var body: some View {
        List {
            if let loadError {
                Text(loadError).foregroundStyle(.secondary)
            } else if visible.isEmpty {
                Text(searchText.isEmpty ? "Empty folder" : "No results")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(visible) { entry in
                    Button {
                        app.open(entry)
                    } label: {
                        FileRow(entry: entry, subtitle: subtitle(for: entry))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(LocalStore.isDocumentsRoot(folder) ? LocalStore.displayName : folder.lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic))
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button { begin(.file) } label: { Label("New File", systemImage: "doc.badge.plus") }
                    Button { begin(.folder) } label: { Label("New Folder", systemImage: "folder.badge.plus") }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .task(id: folder) { reload() }
        .refreshable { reload() }
        .alert(creating?.title ?? "", isPresented: creatingBinding) {
            TextField(creating?.placeholder ?? "", text: $newName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Create") { performCreate() }
            Button("Cancel", role: .cancel) { creating = nil }
        }
        .alert("Error", isPresented: .constant(actionError != nil)) {
            Button("OK") { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
    }

    // MARK: Data

    private func reload() {
        do {
            entries = try FileService.list(folder)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// For search results, show the path relative to this folder as a subtitle.
    private func subtitle(for entry: FileEntry) -> String? {
        guard !searchText.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        let base = folder.path.hasSuffix("/") ? folder.path : folder.path + "/"
        if entry.url.path.hasPrefix(base) {
            let rel = String(entry.url.path.dropFirst(base.count))
            return rel.contains("/") ? rel : nil
        }
        return nil
    }

    // MARK: Create

    private var creatingBinding: Binding<Bool> {
        Binding(get: { creating != nil }, set: { if !$0 { creating = nil } })
    }

    private func begin(_ kind: CreateKind) {
        newName = ""
        creating = kind
    }

    private func performCreate() {
        let kind = creating
        creating = nil
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, let kind else { return }
        do {
            switch kind {
            case .folder:
                _ = try FileService.createFolder(in: folder, named: name)
                reload()
            case .file:
                let fileName = name.contains(".") ? name : name + ".md"
                let url = try FileService.createFile(in: folder, named: fileName)
                reload()
                app.open(FileEntry(url: url, isDirectory: false))
            }
        } catch {
            actionError = error.localizedDescription
        }
    }
}
