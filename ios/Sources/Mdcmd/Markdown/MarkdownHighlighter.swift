import UIKit

/// Applies Markdown syntax highlighting to an `NSTextStorage` in place: headings
/// grow and bold, emphasis renders inline, code is monospaced, and the literal
/// syntax markers (`#`, `**`, backticks, list bullets) are dimmed so the prose
/// leads — the native "styled source" editing model (iA Writer / Bear) chosen
/// over the desktop app's WYSIWYG webview.
struct MarkdownHighlighter {
    var baseSize: CGFloat
    var traits: UITraitCollection

    private var bodyFont: UIFont { UIFont.systemFont(ofSize: baseSize) }
    private var monoFont: UIFont { UIFont.monospacedSystemFont(ofSize: baseSize - 1, weight: .regular) }

    private func headingFont(level: Int) -> UIFont {
        let scale: CGFloat = [1.7, 1.5, 1.3, 1.15, 1.05, 1.0][min(max(level - 1, 0), 5)]
        let f = UIFont.systemFont(ofSize: baseSize * scale, weight: .bold)
        return f
    }

    private func bold(_ f: UIFont) -> UIFont { withTraits(f, .traitBold) }
    private func italic(_ f: UIFont) -> UIFont { withTraits(f, .traitItalic) }
    private func boldItalic(_ f: UIFont) -> UIFont { withTraits(f, [.traitBold, .traitItalic]) }

    private func withTraits(_ font: UIFont, _ t: UIFontDescriptor.SymbolicTraits) -> UIFont {
        let combined = font.fontDescriptor.symbolicTraits.union(t)
        guard let d = font.fontDescriptor.withSymbolicTraits(combined) else { return font }
        return UIFont(descriptor: d, size: font.pointSize)
    }

    // Precompiled inline patterns.
    private static let boldRE = try! NSRegularExpression(pattern: "(\\*\\*|__)(.+?)(\\1)")
    private static let italicRE = try! NSRegularExpression(pattern: "(?<![*_])([*_])(?![*_])(.+?)([*_])")
    private static let strikeRE = try! NSRegularExpression(pattern: "(~~)(.+?)(~~)")
    private static let codeRE = try! NSRegularExpression(pattern: "(`+)([^`]+?)(\\1)")
    private static let linkRE = try! NSRegularExpression(pattern: "(!?\\[)([^\\]]*)(\\]\\()([^\\)\\s]+)(\\))")

    /// Rewrite all styling for `storage`.
    func apply(to storage: NSTextStorage) {
        let text = storage.string
        let full = NSRange(location: 0, length: (text as NSString).length)

        storage.beginEditing()
        // Reset to the body baseline.
        storage.setAttributes(
            [.font: bodyFont, .foregroundColor: MarkdownTheme.body(traits)], range: full)

        let ns = text as NSString
        var inFence = false

        ns.enumerateSubstrings(in: full, options: [.byLines, .substringNotRequired]) {
            _, lineRange, _, _ in
            let line = ns.substring(with: lineRange)
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code blocks: ``` or ~~~ toggle a monospaced/background span
            // covering the fence lines and everything between.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                self.styleCodeLine(storage, lineRange)
                inFence.toggle()
                return
            }
            if inFence {
                self.styleCodeLine(storage, lineRange)
                return
            }

            self.styleBlock(storage, ns, line: line, lineRange: lineRange)
            self.styleInline(storage, ns, lineRange: lineRange)
        }

        storage.endEditing()
    }

    // MARK: Block-level

    private func styleCodeLine(_ storage: NSTextStorage, _ range: NSRange) {
        storage.addAttributes(
            [.font: monoFont,
             .foregroundColor: MarkdownTheme.code(traits),
             .backgroundColor: MarkdownTheme.codeBackground(traits)],
            range: range)
    }

    private func styleBlock(_ storage: NSTextStorage, _ ns: NSString, line: String, lineRange: NSRange) {
        // ATX headings: leading #'s.
        if let hash = line.range(of: "^#{1,6}\\s", options: .regularExpression) {
            let level = line.distance(from: line.startIndex, to: line.firstIndex(where: { $0 != "#" }) ?? line.startIndex)
            storage.addAttribute(.font, value: headingFont(level: level), range: lineRange)
            storage.addAttribute(.foregroundColor, value: MarkdownTheme.heading(traits), range: lineRange)
            // Dim the leading "# " marker.
            let markerLen = line.distance(from: line.startIndex, to: hash.upperBound)
            dim(storage, NSRange(location: lineRange.location, length: markerLen))
            return
        }

        // Blockquote.
        if line.range(of: "^\\s*>\\s?", options: .regularExpression) != nil {
            storage.addAttribute(.foregroundColor, value: MarkdownTheme.secondary(traits), range: lineRange)
        }

        // List markers (-, *, +, or "1.") and task checkboxes.
        if let marker = line.range(of: "^\\s*([-*+]|\\d+\\.)\\s", options: .regularExpression) {
            let start = line.distance(from: line.startIndex, to: marker.lowerBound)
            let len = line.distance(from: marker.lowerBound, to: marker.upperBound)
            colorRange(storage, line: line, lineRange: lineRange, start: start, length: len, color: MarkdownTheme.accent)
            // Task checkbox "[ ]" / "[x]".
            if let box = line.range(of: "\\[[ xX]\\]", options: .regularExpression) {
                let bStart = line.distance(from: line.startIndex, to: box.lowerBound)
                let bLen = line.distance(from: box.lowerBound, to: box.upperBound)
                colorRange(storage, line: line, lineRange: lineRange, start: bStart, length: bLen, color: MarkdownTheme.accent)
            }
        }
    }

    // MARK: Inline

    private func styleInline(_ storage: NSTextStorage, _ ns: NSString, lineRange: NSRange) {
        let line = ns.substring(with: lineRange)
        let lineNS = line as NSString
        let local = NSRange(location: 0, length: lineNS.length)

        func offset(_ r: NSRange) -> NSRange {
            NSRange(location: lineRange.location + r.location, length: r.length)
        }

        // Inline code first (so emphasis inside code is left literal-ish).
        for m in Self.codeRE.matches(in: line, range: local) {
            storage.addAttributes(
                [.font: monoFont,
                 .foregroundColor: MarkdownTheme.code(traits),
                 .backgroundColor: MarkdownTheme.codeBackground(traits)],
                range: offset(m.range))
            dim(storage, offset(m.range(at: 1)))
            dim(storage, offset(m.range(at: 3)))
        }

        // Bold.
        for m in Self.boldRE.matches(in: line, range: local) {
            let inner = offset(m.range(at: 2))
            applyFontTrait(storage, inner) { self.bold($0) }
            dim(storage, offset(m.range(at: 1)))
            dim(storage, offset(m.range(at: 3)))
        }

        // Italic (single * or _).
        for m in Self.italicRE.matches(in: line, range: local) {
            let inner = offset(m.range(at: 2))
            applyFontTrait(storage, inner) { self.italic($0) }
            dim(storage, offset(m.range(at: 1)))
            dim(storage, offset(m.range(at: 3)))
        }

        // Strikethrough.
        for m in Self.strikeRE.matches(in: line, range: local) {
            storage.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: offset(m.range(at: 2)))
            dim(storage, offset(m.range(at: 1)))
            dim(storage, offset(m.range(at: 3)))
        }

        // Links / images: color the visible text, dim the URL machinery.
        for m in Self.linkRE.matches(in: line, range: local) {
            storage.addAttribute(.foregroundColor, value: MarkdownTheme.link, range: offset(m.range(at: 2)))
            dim(storage, offset(m.range(at: 1)))
            dim(storage, offset(m.range(at: 3)))
            storage.addAttribute(.foregroundColor, value: MarkdownTheme.secondary(traits), range: offset(m.range(at: 4)))
            dim(storage, offset(m.range(at: 5)))
        }
    }

    // MARK: Helpers

    private func applyFontTrait(_ storage: NSTextStorage, _ range: NSRange, _ transform: (UIFont) -> UIFont) {
        guard range.length > 0, range.location + range.length <= storage.length else { return }
        storage.enumerateAttribute(.font, in: range) { value, sub, _ in
            let font = (value as? UIFont) ?? bodyFont
            storage.addAttribute(.font, value: transform(font), range: sub)
        }
    }

    private func dim(_ storage: NSTextStorage, _ range: NSRange) {
        guard range.length > 0, range.location + range.length <= storage.length else { return }
        storage.addAttribute(.foregroundColor, value: MarkdownTheme.syntaxMarker(traits), range: range)
    }

    private func colorRange(_ storage: NSTextStorage, line: String, lineRange: NSRange, start: Int, length: Int, color: UIColor) {
        let lineNS = line as NSString
        // Convert a Swift character offset to a UTF-16 range within the line.
        let prefix = String(line.prefix(start))
        let loc = (prefix as NSString).length
        let sub = lineNS.substring(from: loc)
        let len = (String(sub.prefix(length)) as NSString).length
        let range = NSRange(location: lineRange.location + loc, length: len)
        guard range.location + range.length <= storage.length else { return }
        storage.addAttribute(.foregroundColor, value: color, range: range)
    }
}
