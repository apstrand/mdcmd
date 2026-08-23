import SwiftUI

/// Editor + preview for one Markdown document. Native replacement for
/// `src/components/MarkdownEditor.tsx`: a styled-source editor with an
/// Edit/Preview toggle, explicit save plus auto-save on leave/background, dirty
/// tracking, a pin toggle, and a keyboard formatting bar.
struct DocumentView: View {
    @ObservedObject var session: DocumentSession
    @EnvironmentObject private var app: AppState
    @Environment(\.scenePhase) private var scenePhase

    @StateObject private var editor = EditorController()
    @State private var mode: Mode = .edit
    @State private var fontSize: CGFloat = CGFloat(Prefs.editorFontSize)
    @State private var saveError: String?
    /// Set once after a Quick Note / open-with jump to move the cursor to the end.
    var focusAtEnd: Bool = false

    enum Mode: String, CaseIterable { case edit = "Edit", preview = "Preview" }

    private var baseURL: URL { session.url.deletingLastPathComponent() }

    var body: some View {
        Group {
            if let err = session.loadError {
                unreadable(err)
            } else if mode == .edit {
                MarkdownTextEditor(text: $session.text, fontSize: fontSize, controller: editor)
                    .background(Color(.systemBackground))
                    // The editor manages its own keyboard inset (see
                    // MarkdownTextEditor.Coordinator) so opt out of SwiftUI's
                    // avoidance to prevent double-scrolling jitter.
                    .ignoresSafeArea(.keyboard, edges: .bottom)
            } else {
                MarkdownPreview(text: session.text, baseURL: baseURL, fontSize: fontSize)
            }
        }
        .navigationTitle(session.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .toolbar { if mode == .edit { keyboardToolbar } }
        .onAppear {
            if focusAtEnd {
                mode = .edit
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    editor.moveToEnd()
                }
                app.focusAtEndPath = nil
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { autosave() }
        }
        .onDisappear { autosave() }
        .alert("Couldn't Save", isPresented: .constant(saveError != nil)) {
            Button("OK") { saveError = nil }
        } message: {
            Text(saveError ?? "")
        }
    }

    // MARK: Toolbars

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            Picker("Mode", selection: $mode) {
                ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(width: 180)
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
            if session.isDirty {
                Button {
                    save()
                } label: {
                    Label("Save", systemImage: "square.and.arrow.down")
                }
            }

            Menu {
                Button {
                    app.togglePin(session.path, isDir: false)
                } label: {
                    Label(
                        app.isPinned(session.path) ? "Unpin" : "Pin to Shortcuts",
                        systemImage: app.isPinned(session.path) ? "pin.slash" : "pin")
                }

                if app.isPinned(session.path) {
                    Button {
                        let isTarget = app.quickNoteTarget == session.path
                        app.setQuickNoteTarget(isTarget ? nil : session.path)
                    } label: {
                        Label(
                            app.quickNoteTarget == session.path
                                ? "Unset Quick Note" : "Set as Quick Note",
                            systemImage: "bolt")
                    }
                }

                Divider()

                Button { setFont(fontSize + 1) } label: { Label("Larger Text", systemImage: "textformat.size.larger") }
                Button { setFont(fontSize - 1) } label: { Label("Smaller Text", systemImage: "textformat.size.smaller") }

                Divider()

                ShareLink(item: session.url) { Label("Share", systemImage: "square.and.arrow.up") }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    @ToolbarContentBuilder
    private var keyboardToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .keyboard) {
            Button { editor.prefixLine("# ") } label: { Image(systemName: "number") }
            Button { editor.wrap(prefix: "**", suffix: "**") } label: { Image(systemName: "bold") }
            Button { editor.wrap(prefix: "_", suffix: "_") } label: { Image(systemName: "italic") }
            Button { editor.wrap(prefix: "`", suffix: "`") } label: { Image(systemName: "chevron.left.forwardslash.chevron.right") }
            Button { editor.prefixLine("- ") } label: { Image(systemName: "list.bullet") }
            Button { editor.prefixLine("- [ ] ") } label: { Image(systemName: "checklist") }
            Button { editor.wrap(prefix: "[", suffix: "](url)") } label: { Image(systemName: "link") }
            Spacer()
            Button("Done") { UIApplication.shared.dismissKeyboard() }
        }
    }

    // MARK: Views

    private func unreadable(_ err: String) -> some View {
        ContentUnavailableView {
            Label("Can't Open File", systemImage: "doc.questionmark")
        } description: {
            Text(err)
        }
    }

    // MARK: Actions

    private func save() {
        do {
            try session.save()
        } catch {
            saveError = error.localizedDescription
        }
    }

    private func autosave() {
        guard session.isDirty, session.loadError == nil else { return }
        try? session.save()
    }

    private func setFont(_ size: CGFloat) {
        let clamped = min(max(size, 12), 32)
        fontSize = clamped
        Prefs.editorFontSize = Double(clamped)
    }
}

extension UIApplication {
    func dismissKeyboard() {
        sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}
