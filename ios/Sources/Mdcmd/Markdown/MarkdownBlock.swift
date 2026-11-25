import Foundation

/// A list item with optional task-checkbox state.
struct ListItem {
    let text: String
    /// `nil` = plain bullet, `true`/`false` = checked/unchecked task item.
    let checked: Bool?
}

/// Column alignment for a GFM pipe table, read from its delimiter row
/// (`:---` left, `:---:` center, `---:` right, `---` unset).
enum ColumnAlignment {
    case left, center, right, none
}

/// A coarse block-level Markdown element. A deliberately small grammar covering
/// the constructs the editor produces; inline emphasis/links are handled later
/// by `AttributedString(markdown:)` in the preview.
enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bullet([ListItem])
    case ordered([ListItem])
    case quote(String)
    case code(String)
    case rule
    case image(alt: String, path: String)
    case table(header: [String], alignments: [ColumnAlignment], rows: [[String]])

    /// Split Markdown source into blocks.
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        let lines = source.components(separatedBy: "\n")
        var i = 0

        func flushParagraph(_ buffer: inout [String]) {
            guard !buffer.isEmpty else { return }
            blocks.append(.paragraph(buffer.joined(separator: "\n")))
            buffer.removeAll()
        }

        var paragraph: [String] = []

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Blank line ends a paragraph.
            if trimmed.isEmpty {
                flushParagraph(&paragraph)
                i += 1
                continue
            }

            // Fenced code block.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph(&paragraph)
                let fence = String(trimmed.prefix(3))
                var code: [String] = []
                i += 1
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    if l.hasPrefix(fence) { i += 1; break }
                    code.append(lines[i])
                    i += 1
                }
                blocks.append(.code(code.joined(separator: "\n")))
                continue
            }

            // Horizontal rule.
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph(&paragraph)
                blocks.append(.rule)
                i += 1
                continue
            }

            // Heading.
            if let m = trimmed.range(of: "^#{1,6}\\s+", options: .regularExpression) {
                flushParagraph(&paragraph)
                let level = trimmed.prefix(while: { $0 == "#" }).count
                let text = String(trimmed[m.upperBound...])
                blocks.append(.heading(level: level, text: text))
                i += 1
                continue
            }

            // GFM pipe table: a header row (contains `|`) immediately followed
            // by a delimiter row (`| --- | :--: |`). The delimiter is what
            // distinguishes a table from a paragraph that happens to use pipes.
            if trimmed.contains("|"), i + 1 < lines.count,
                let alignments = parseDelimiterRow(lines[i + 1]) {
                flushParagraph(&paragraph)
                let header = splitTableRow(trimmed)
                i += 2
                var rows: [[String]] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    if l.isEmpty || !l.contains("|") { break }
                    rows.append(splitTableRow(l))
                    i += 1
                }
                blocks.append(.table(header: header, alignments: alignments, rows: rows))
                continue
            }

            // Standalone image line: ![alt](path)
            if let img = parseImage(trimmed) {
                flushParagraph(&paragraph)
                blocks.append(.image(alt: img.alt, path: img.path))
                i += 1
                continue
            }

            // Blockquote (consume consecutive quote lines).
            if trimmed.hasPrefix(">") {
                flushParagraph(&paragraph)
                var quote: [String] = []
                while i < lines.count {
                    let l = lines[i].trimmingCharacters(in: .whitespaces)
                    guard l.hasPrefix(">") else { break }
                    quote.append(String(l.drop(while: { $0 == ">" })).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                blocks.append(.quote(quote.joined(separator: "\n")))
                continue
            }

            // Unordered / task list (consume consecutive items).
            if trimmed.range(of: "^[-*+]\\s+", options: .regularExpression) != nil {
                flushParagraph(&paragraph)
                var items: [ListItem] = []
                while i < lines.count,
                    let r = lines[i].trimmingCharacters(in: .whitespaces).range(of: "^[-*+]\\s+", options: .regularExpression) {
                    let rest = String(lines[i].trimmingCharacters(in: .whitespaces)[r.upperBound...])
                    items.append(parseListItem(rest))
                    i += 1
                }
                blocks.append(.bullet(items))
                continue
            }

            // Ordered list.
            if trimmed.range(of: "^\\d+\\.\\s+", options: .regularExpression) != nil {
                flushParagraph(&paragraph)
                var items: [ListItem] = []
                while i < lines.count,
                    let r = lines[i].trimmingCharacters(in: .whitespaces).range(of: "^\\d+\\.\\s+", options: .regularExpression) {
                    let rest = String(lines[i].trimmingCharacters(in: .whitespaces)[r.upperBound...])
                    items.append(ListItem(text: rest, checked: nil))
                    i += 1
                }
                blocks.append(.ordered(items))
                continue
            }

            // Otherwise: accumulate into the current paragraph.
            paragraph.append(line)
            i += 1
        }

        flushParagraph(&paragraph)
        return blocks
    }

    private static func parseListItem(_ text: String) -> ListItem {
        if let r = text.range(of: "^\\[([ xX])\\]\\s*", options: .regularExpression) {
            let mark = text[text.index(text.startIndex, offsetBy: 1)]
            let checked = (mark == "x" || mark == "X")
            return ListItem(text: String(text[r.upperBound...]), checked: checked)
        }
        return ListItem(text: text, checked: nil)
    }

    /// Parse a table delimiter row into column alignments, or `nil` if the line
    /// isn't one. Requires at least one `|` so a paragraph followed by a `---`
    /// horizontal rule isn't mistaken for a (one-column) table.
    private static func parseDelimiterRow(_ line: String) -> [ColumnAlignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("|"), trimmed.contains("-") else { return nil }
        let cells = splitTableRow(trimmed)
        guard !cells.isEmpty else { return nil }
        var alignments: [ColumnAlignment] = []
        for cell in cells {
            guard cell.range(of: "^:?-+:?$", options: .regularExpression) != nil else { return nil }
            switch (cell.hasPrefix(":"), cell.hasSuffix(":")) {
            case (true, true): alignments.append(.center)
            case (true, false): alignments.append(.left)
            case (false, true): alignments.append(.right)
            default: alignments.append(.none)
            }
        }
        return alignments
    }

    /// Split a table row on unescaped `|`, trimming cells and dropping the empty
    /// leading/trailing cells produced by the outer pipes. `\|` becomes a literal
    /// pipe (matching the web serializer's escaping in `markdownTable.ts`).
    private static func splitTableRow(_ line: String) -> [String] {
        var cells: [String] = []
        var current = ""
        var escaped = false
        for ch in line.trimmingCharacters(in: .whitespaces) {
            if escaped {
                if ch == "|" { current.append("|") } else { current.append("\\"); current.append(ch) }
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "|" {
                cells.append(current)
                current = ""
            } else {
                current.append(ch)
            }
        }
        if escaped { current.append("\\") }
        cells.append(current)
        var trimmed = cells.map { $0.trimmingCharacters(in: .whitespaces) }
        if trimmed.first == "" { trimmed.removeFirst() }
        if trimmed.last == "" { trimmed.removeLast() }
        return trimmed
    }

    private static func parseImage(_ line: String) -> (alt: String, path: String)? {
        guard let m = line.range(of: "^!\\[[^\\]]*\\]\\([^\\)\\s]+\\)$", options: .regularExpression) else { return nil }
        let s = String(line[m])
        guard let altStart = s.firstIndex(of: "["),
            let altEnd = s.firstIndex(of: "]"),
            let pathStart = s.firstIndex(of: "("),
            let pathEnd = s.lastIndex(of: ")") else { return nil }
        let alt = String(s[s.index(after: altStart)..<altEnd])
        let path = String(s[s.index(after: pathStart)..<pathEnd])
        return (alt, path)
    }
}
