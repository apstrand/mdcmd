import SwiftUI

/// A read-only, natively-rendered Markdown preview. Parses block structure
/// (headings, lists, code, quotes, rules, images) itself and renders inline
/// emphasis/links via `AttributedString(markdown:)`. This is the "Preview" half
/// of the Edit/Preview editor, replacing the desktop Tiptap render.
struct MarkdownPreview: View {
    let text: String
    /// Folder of the document, for resolving relative image paths.
    let baseURL: URL
    /// Body point size; headings scale relative to it so Preview tracks the
    /// editor's size (and its zoom). Defaults to the system body size.
    var fontSize: CGFloat = 17

    /// Extra leading between wrapped lines, for comfortable reading.
    private var lineSpacing: CGFloat { fontSize * 0.3 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: fontSize * 0.7) {
                ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                    view(for: block)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .textSelection(.enabled)
        }
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            inline(text)
                .font(headingFont(level))
                .lineSpacing(lineSpacing * 0.5)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, level <= 2 ? fontSize * 0.5 : fontSize * 0.2)

        case .paragraph(let text):
            inline(text)
                .font(.system(size: fontSize))
                .lineSpacing(lineSpacing)
                .fixedSize(horizontal: false, vertical: true)

        case .bullet(let items):
            VStack(alignment: .leading, spacing: fontSize * 0.4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        checkboxOrBullet(item)
                        inline(item.text)
                            .font(.system(size: fontSize))
                            .lineSpacing(lineSpacing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

        case .ordered(let items):
            VStack(alignment: .leading, spacing: fontSize * 0.4) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(idx + 1).")
                            .font(.system(size: fontSize))
                            .foregroundStyle(.secondary).monospacedDigit()
                        inline(item.text)
                            .font(.system(size: fontSize))
                            .lineSpacing(lineSpacing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

        case .quote(let text):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.accentColor.opacity(0.5)).frame(width: 3)
                inline(text)
                    .font(.system(size: fontSize))
                    .lineSpacing(lineSpacing)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

        case .code(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: fontSize * 0.9, design: .monospaced))
                    .padding(12)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 8))

        case .rule:
            Divider()

        case .image(let alt, let path):
            imageView(alt: alt, path: path)
        }
    }

    private func inline(_ s: String) -> Text {
        if let attr = try? AttributedString(
            markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(attr)
        }
        return Text(s)
    }

    @ViewBuilder
    private func checkboxOrBullet(_ item: ListItem) -> some View {
        switch item.checked {
        case .some(true):
            Image(systemName: "checkmark.square.fill").foregroundStyle(Color.accentColor)
        case .some(false):
            Image(systemName: "square").foregroundStyle(.secondary)
        case .none:
            Text("•").foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func imageView(alt: String, path: String) -> some View {
        let url = resolvedURL(path)
        if let url {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                default:
                    placeholder(alt: alt)
                }
            }
        } else {
            placeholder(alt: alt)
        }
    }

    private func placeholder(alt: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "photo").foregroundStyle(.secondary)
            Text(alt.isEmpty ? "image" : alt).foregroundStyle(.secondary).font(.footnote)
        }
    }

    private func resolvedURL(_ path: String) -> URL? {
        if path.hasPrefix("http://") || path.hasPrefix("https://") {
            return URL(string: path)
        }
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path)
        }
        return baseURL.appendingPathComponent(path).standardizedFileURL
    }

    /// Headings scale off the body size for a compact, consistent hierarchy
    /// (rather than the very large `.largeTitle`/`.title` system ramp).
    private func headingFont(_ level: Int) -> Font {
        let scale: CGFloat
        let weight: Font.Weight
        switch level {
        case 1: scale = 1.6; weight = .bold
        case 2: scale = 1.35; weight = .bold
        case 3: scale = 1.18; weight = .semibold
        case 4: scale = 1.05; weight = .semibold
        default: scale = 1.0; weight = .semibold
        }
        return .system(size: fontSize * scale, weight: weight)
    }
}
