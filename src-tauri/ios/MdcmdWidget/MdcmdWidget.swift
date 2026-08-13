import SwiftUI
import WidgetKit

// A deliberately "dumb" widget: WidgetKit can't host a real text field, so
// this isn't an editor — it's a fast launcher. Tapping it opens
// mdcmd://quick-note, which the main app (see App.tsx's quick-note-requested
// handling, fed by RunEvent::Opened in src-tauri/src/lib.rs) turns into
// "open the configured Quick Note Target file, cursor at the end, keyboard
// up." No configuration, no App Group, no dynamic content — the same single
// entry is shown forever (see the `.never` reload policy below).
struct QuickNoteEntry: TimelineEntry {
  let date: Date
}

struct QuickNoteProvider: TimelineProvider {
  func placeholder(in context: Context) -> QuickNoteEntry {
    QuickNoteEntry(date: Date())
  }

  func getSnapshot(in context: Context, completion: @escaping (QuickNoteEntry) -> Void) {
    completion(QuickNoteEntry(date: Date()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<QuickNoteEntry>) -> Void) {
    let timeline = Timeline(entries: [QuickNoteEntry(date: Date())], policy: .never)
    completion(timeline)
  }
}

struct MdcmdWidgetEntryView: View {
  var entry: QuickNoteProvider.Entry

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: "square.and.pencil")
        .font(.system(size: 28))
        .foregroundStyle(.tint)
      Text("Quick Note")
        .font(.caption)
        .fontWeight(.semibold)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    // The whole tile is one tap target — simpler than Link(destination:) for
    // a single-action systemSmall widget.
    .widgetURL(URL(string: "mdcmd://quick-note"))
  }
}

struct MdcmdWidget: Widget {
  let kind: String = "MdcmdWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: QuickNoteProvider()) { entry in
      if #available(iOS 17.0, *) {
        MdcmdWidgetEntryView(entry: entry)
          .containerBackground(.fill.tertiary, for: .widget)
      } else {
        MdcmdWidgetEntryView(entry: entry)
          .padding()
          .background()
      }
    }
    .configurationDisplayName("Quick Note")
    .description("Jump straight into your Quick Note document.")
    .supportedFamilies([.systemSmall])
  }
}
