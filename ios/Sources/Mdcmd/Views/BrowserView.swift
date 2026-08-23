import SwiftUI
import UniformTypeIdentifiers

/// Root of the app. On iPhone (compact) it's a single navigation stack; on iPad
/// (regular width) it's a two-column split view — the browser in the sidebar and
/// the open document in the detail column, so editing doesn't push back and
/// forth. Replaces the desktop sidebar (`src/components/FileBrowser.tsx`).
struct BrowserView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var picking: PickKind?

    private enum PickKind: Identifiable {
        case folder, file
        var id: Int { hashValue }
    }

    private var isSplit: Bool { sizeClass == .regular }

    var body: some View {
        Group {
            if isSplit {
                splitLayout
            } else {
                stackLayout
            }
        }
        .onAppear { app.isSplit = isSplit }
        .onChange(of: sizeClass) { _, _ in app.isSplit = isSplit }
        .fileImporter(
            isPresented: Binding(
                get: { picking != nil },
                set: { if !$0 { picking = nil } }),
            allowedContentTypes: allowedTypes(for: picking),
            allowsMultipleSelection: false
        ) { result in
            handlePick(result)
        }
    }

    // MARK: Layouts

    private var home: some View {
        HomeList(onAddFolder: { picking = .folder }, onAddFile: { picking = .file })
            .navigationTitle("MarkDown Commander")
            // Inline so the full name is legible (a large title truncates it);
            // the hero header carries the visual branding.
            .navigationBarTitleDisplayMode(.inline)
    }

    /// iPhone: everything pushes onto one stack.
    private var stackLayout: some View {
        NavigationStack(path: $app.navPath) {
            home.navigationDestination(for: Route.self) { route in
                destination(for: route)
            }
        }
    }

    /// iPad: sidebar browses folders, detail shows the open document/media.
    private var splitLayout: some View {
        NavigationSplitView {
            NavigationStack(path: $app.browsePath) {
                home.navigationDestination(for: URL.self) { url in
                    FolderView(folder: url)
                }
            }
        } detail: {
            NavigationStack {
                detailColumn
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    @ViewBuilder
    private var detailColumn: some View {
        switch app.detailSelection {
        case .document(let path):
            DocumentView(session: app.session(for: path), focusAtEnd: app.focusAtEndPath == path)
                .id(path)
        case .media(let entry):
            MediaView(entry: entry).id(entry.id)
        case .info(let topic):
            InfoView(topic: topic).id(topic.id)
        default:
            ContentUnavailableView(
                "No Note Selected", systemImage: "doc.text",
                description: Text("Pick a note from the sidebar, or add a folder or file to get started."))
        }
    }

    // MARK: Destinations (stack)

    @ViewBuilder
    private func destination(for route: Route) -> some View {
        switch route {
        case .folder(let url):
            FolderView(folder: url)
        case .document(let path):
            DocumentView(
                session: app.session(for: path),
                focusAtEnd: app.focusAtEndPath == path)
        case .media(let entry):
            MediaView(entry: entry)
        case .info(let topic):
            InfoView(topic: topic)
        }
    }

    // MARK: Picking

    private func allowedTypes(for kind: PickKind?) -> [UTType] {
        switch kind {
        case .folder, .none:
            return [.folder]
        case .file:
            var types: [UTType] = [.plainText, .text]
            if let md = UTType("net.daringfireball.markdown") { types.insert(md, at: 0) }
            types.append(.data)
            return types
        }
    }

    private func handlePick(_ result: Result<[URL], Error>) {
        let kind = picking
        picking = nil
        guard case .success(let urls) = result, let url = urls.first else { return }
        // The picker returns a security-scoped URL; activate + bookmark it so
        // access survives relaunch, then pin and navigate in.
        guard url.startAccessingSecurityScopedResource() else { return }
        BookmarkStore.add(url)
        let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? (kind == .folder)
        app.pin(url.path, isDir: isDir)
        app.open(FileEntry(url: url, isDirectory: isDir))
    }
}

/// The Home screen: an intro hero, the built-in local location, pinned
/// shortcuts, and (until the user adds their own) a short capabilities tour.
private struct HomeList: View {
    @EnvironmentObject private var app: AppState
    @StateObject private var tree = ShortcutTree()
    @State private var showingHelp = false
    let onAddFolder: () -> Void
    let onAddFile: () -> Void

    /// Show the capability tour until the user has added something of their own
    /// (the seeded welcome note counts as one).
    private var showTour: Bool { app.sortedShortcuts.count <= 1 }

    var body: some View {
        List {
            Section {
                heroHeader
            }

            Section {
                myDocumentsRow

                if app.sortedShortcuts.isEmpty {
                    Button(action: onAddFolder) {
                        Label("Add a Folder or File…", systemImage: "plus.circle")
                    }
                } else {
                    ForEach(app.sortedShortcuts) { item in
                        if item.isDir {
                            folderHeader(item)
                            if tree.isExpanded(item.path) {
                                ForEach(tree.children(of: item.path) ?? []) { child in
                                    childRow(child)
                                }
                            }
                        } else {
                            shortcutRow(item)
                        }
                    }
                }
            } header: {
                Text("Shortcuts")
            } footer: {
                Text("Add folders or files from Files, iCloud Drive, Dropbox, or Google Drive with the + button above.")
            }

            if showTour {
                Section("What you can do") {
                    ForEach(TourTopic.allCases) { topic in
                        Button {
                            app.showInfo(topic)
                        } label: {
                            feature(topic)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showingHelp = true
                } label: {
                    Image(systemName: "questionmark.circle")
                }
                .accessibilityLabel("Help")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu {
                    Button(action: onAddFolder) { Label("Add Folder…", systemImage: "folder.badge.plus") }
                    Button(action: onAddFile) { Label("Add File…", systemImage: "doc.badge.plus") }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showingHelp) { HelpView() }
    }

    // MARK: Pieces

    private var heroHeader: some View {
        VStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(LinearGradient(
                        colors: [Color.accentColor, Color.accentColor.opacity(0.65)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 66, height: 66)
                    .shadow(color: Color.accentColor.opacity(0.35), radius: 10, y: 5)
                Image(systemName: "text.alignleft")
                    .font(.system(size: 30, weight: .bold))
                    .foregroundStyle(.white)
            }
            Text("Edit Markdown in the files you already have — your iPhone, iCloud Drive, Dropbox, and more.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    /// The built-in on-device Documents folder ("My Documents"), always shown at
    /// the top of Shortcuts. Not removable, so it's a plain navigating row.
    private var myDocumentsRow: some View {
        Button {
            app.open(LocalStore.entry)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "folder")
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 22)
                Text(LocalStore.displayName)
                    .foregroundStyle(.primary)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func feature(_ topic: TourTopic) -> some View {
        HStack(spacing: 14) {
            TourTopicRow(topic: topic)
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func shortcutRow(_ item: PinnedItem) -> some View {
        let entry = FileEntry(url: item.url, isDirectory: item.isDir)
        Button {
            app.open(entry)
        } label: {
            FileRow(entry: entry)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                app.unpin(item.path)
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading) {
            if !item.isDir {
                Button {
                    let isTarget = app.quickNoteTarget == item.path
                    app.setQuickNoteTarget(isTarget ? nil : item.path)
                } label: {
                    Label("Quick Note", systemImage: "bolt")
                }
                .tint(app.quickNoteTarget == item.path ? .gray : .yellow)
            }
        }
    }

    /// A pinned *folder* shortcut. A chevron expands its immediate contents
    /// inline (one level) so files can be opened without drilling in; tapping the
    /// name still opens the full folder browser. Small folders auto-expand.
    @ViewBuilder
    private func folderHeader(_ item: PinnedItem) -> some View {
        let kids = tree.children(of: item.path)
        HStack(spacing: 8) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { tree.toggle(item.path) }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(tree.isExpanded(item.path) ? 90 : 0))
                    .frame(width: 16, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(kids?.isEmpty ?? true)

            Button {
                app.open(FileEntry(url: item.url, isDirectory: true))
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "folder")
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 22)
                    Text(item.name).lineLimit(1).foregroundStyle(.primary)
                    Spacer()
                    if let kids, !kids.isEmpty, !tree.isExpanded(item.path) {
                        Text("\(kids.count)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .task { tree.ensureLoaded(item.url) }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                app.unpin(item.path)
            } label: {
                Label("Remove", systemImage: "trash")
            }
        }
    }

    /// An immediate child of an expanded folder shortcut, indented under it.
    private func childRow(_ entry: FileEntry) -> some View {
        Button {
            app.open(entry)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: entry.kind.systemImage)
                    .font(.footnote)
                    .foregroundStyle(entry.isDirectory ? Color.accentColor : Color.secondary)
                    .frame(width: 20)
                Text(entry.name).font(.callout).lineLimit(1)
                Spacer()
                if entry.isDirectory {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.leading, 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Loads and caches the immediate contents of pinned folder shortcuts so the
/// Home screen can show a one-level inline tree. Small folders (≤
/// ``autoExpandLimit`` entries) auto-expand; the user can toggle any folder.
@MainActor
private final class ShortcutTree: ObservableObject {
    /// Above this size a folder stays collapsed unless the user expands it, so a
    /// big shortcut doesn't flood the Home screen.
    private let autoExpandLimit = 8

    @Published private var childrenByPath: [String: [FileEntry]] = [:]
    /// Manual expand/collapse overrides, keyed by folder path.
    @Published private var overrides: [String: Bool] = [:]
    private var loading: Set<String> = []

    func children(of path: String) -> [FileEntry]? { childrenByPath[path] }

    /// List a folder's immediate contents once, off the main actor's critical
    /// path. Safe to call repeatedly (it de-dupes in-flight and cached loads).
    func ensureLoaded(_ url: URL) {
        let path = url.path
        guard childrenByPath[path] == nil, !loading.contains(path) else { return }
        loading.insert(path)
        Task {
            let entries = (try? FileService.list(url)) ?? []
            childrenByPath[path] = entries
            loading.remove(path)
        }
    }

    func isExpanded(_ path: String) -> Bool {
        if let override = overrides[path] { return override }
        // Default: expand once loaded if it's small (and non-empty).
        if let kids = childrenByPath[path] { return !kids.isEmpty && kids.count <= autoExpandLimit }
        return false
    }

    func toggle(_ path: String) {
        overrides[path] = !isExpanded(path)
    }
}
