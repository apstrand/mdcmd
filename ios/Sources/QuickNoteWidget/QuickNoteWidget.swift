import WidgetKit
import SwiftUI

/// Home Screen widget that jumps straight into the note the user designated as
/// their Quick Note (mirrors the Tauri app's Quick Note target). The target's
/// display name is shared from the app through an App Group; tapping the widget
/// opens `mdcmd://quicknote`, which the app resolves to the current target.
private let appGroup = "group.com.mdcmd.ios"

struct QuickNoteEntry: TimelineEntry {
    let date: Date
    let name: String?
}

struct QuickNoteProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuickNoteEntry {
        QuickNoteEntry(date: Date(), name: "Quick Note")
    }

    func getSnapshot(in context: Context, completion: @escaping (QuickNoteEntry) -> Void) {
        completion(current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<QuickNoteEntry>) -> Void) {
        completion(Timeline(entries: [current()], policy: .never))
    }

    private func current() -> QuickNoteEntry {
        let name = UserDefaults(suiteName: appGroup)?.string(forKey: "quicknote.name")
        return QuickNoteEntry(date: Date(), name: name)
    }
}

struct QuickNoteWidgetView: View {
    var entry: QuickNoteEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: "bolt.fill")
                .font(.title2)
                .foregroundStyle(.tint)
            Spacer(minLength: 0)
            if let name = entry.name {
                Text("Quick Note")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(name)
                    .font(.headline)
                    .lineLimit(2)
            } else {
                Text("Set a Quick Note")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(URL(string: "mdcmd://quicknote"))
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

@main
struct QuickNoteWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "QuickNoteWidget", provider: QuickNoteProvider()) { entry in
            QuickNoteWidgetView(entry: entry)
        }
        .configurationDisplayName("Quick Note")
        .description("Jump straight into your designated note.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
