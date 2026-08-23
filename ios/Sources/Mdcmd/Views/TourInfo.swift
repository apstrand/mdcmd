import SwiftUI

/// The "What you can do" items on the Home screen. Each is both a row (icon +
/// title + subtitle) and a short Markdown help page shown, in preview, when
/// tapped (``InfoView``).
enum TourTopic: String, CaseIterable, Identifiable, Hashable {
    case browse, write, pin, openInPlace

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .browse: return "folder.fill"
        case .write: return "square.and.pencil"
        case .pin: return "pin.fill"
        case .openInPlace: return "arrow.down.doc.fill"
        }
    }

    var title: String {
        switch self {
        case .browse: return "Browse anywhere"
        case .write: return "Write & preview"
        case .pin: return "Pin shortcuts"
        case .openInPlace: return "Open in place"
        }
    }

    var subtitle: String {
        switch self {
        case .browse: return "Files, iCloud Drive, Dropbox, Google Drive"
        case .write: return "Live Markdown with a rendered preview"
        case .pin: return "Keep favorite folders and notes one tap away"
        case .openInPlace: return "Edit files opened from other apps"
        }
    }

    /// A short Markdown description of the action, rendered read-only.
    var markdown: String {
        switch self {
        case .browse:
            return """
            # Browse anywhere

            Work with the Markdown files you already have — wherever they live.

            Tap **＋** on the Home screen to add a **folder** or a single **file** from:

            - **My Documents** — the app's own on-device space
            - **iCloud Drive**
            - **Dropbox**, **Google Drive**, and other providers in the Files app

            Open a folder to browse it, tap a note to read or edit it, and use search to find files by name.
            """
        case .write:
            return """
            # Write & preview

            The editor shows your Markdown source with **live syntax highlighting**, so it reads like formatted text while staying fully editable.

            - Switch between **Edit** and **Preview** with the toggle in the title bar.
            - The keyboard bar adds headings, **bold**, _italic_, `code`, links, lists, and checkboxes.
            - Press **Return** in a list to continue it automatically; an empty item ends the list.
            - Changes save automatically when you leave a note, or tap **Save** any time.
            """
        case .pin:
            return """
            # Pin shortcuts

            Keep the folders and notes you use most one tap away.

            - **Pin** any folder or file — it appears under **Shortcuts** on the Home screen.
            - Pinned folders **expand inline** so you can open a file without drilling in.
            - **Swipe** a shortcut to remove it (this only unpins it — your file stays put).
            - Swipe a note to set it as your **Quick Note** for fast capture.
            """
        case .openInPlace:
            return """
            # Open in place

            Open a Markdown or text file from **any** app — Files, Mail, Safari — using **Open With** or the share sheet, and pick **MarkDown Commander**.

            Your edits are saved **back to the original file**, not a copy. So a note in Dropbox or iCloud stays in sync everywhere you use it.
            """
        }
    }
}

/// Renders a ``TourTopic``'s help page as read-only Markdown (the "Preview"
/// half of the editor), pushed from the Home screen's "What you can do" list.
struct InfoView: View {
    let topic: TourTopic

    var body: some View {
        MarkdownPreview(text: topic.markdown, baseURL: URL(fileURLWithPath: NSTemporaryDirectory()))
            .navigationTitle(topic.title)
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// A tour item's icon + title + subtitle, shared by the Home "What you can do"
/// section and the Help sheet.
struct TourTopicRow: View {
    let topic: TourTopic

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: topic.icon)
                .font(.system(size: 18))
                .foregroundStyle(Color.accentColor)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(topic.title).font(.subheadline.weight(.semibold))
                Text(topic.subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// The Help sheet: the "What you can do" topics, always reachable from the Home
/// toolbar's "?" button (the inline tour only shows until the user adds their
/// own shortcuts). Each topic opens its Markdown page.
struct HelpView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(TourTopic.allCases) { topic in
                        NavigationLink(value: topic) { TourTopicRow(topic: topic) }
                    }
                } header: {
                    Text("What you can do")
                } footer: {
                    Text("Tap a topic to learn more.")
                }
            }
            .navigationTitle("Help")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: TourTopic.self) { InfoView(topic: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
