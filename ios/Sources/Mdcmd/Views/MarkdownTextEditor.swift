import SwiftUI
import UIKit

/// Bridges a `UITextView` into SwiftUI with live Markdown syntax highlighting.
/// The text is styled in place on every edit by ``MarkdownHighlighter`` so the
/// source stays fully editable while reading like formatted prose.
///
/// The view opts out of SwiftUI's automatic keyboard avoidance (see the
/// `.ignoresSafeArea(.keyboard)` in ``DocumentView``) and instead manages its
/// own bottom `contentInset` from the live keyboard frame — this keeps the
/// caret above the keyboard without the double-avoidance jitter that made
/// editing "scroll around" on device.
struct MarkdownTextEditor: UIViewRepresentable {
    @Binding var text: String
    var fontSize: CGFloat
    var controller: EditorController

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.delegate = context.coordinator
        tv.backgroundColor = .clear
        tv.alwaysBounceVertical = true
        tv.keyboardDismissMode = .interactive
        tv.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)
        tv.autocorrectionType = .yes
        // Markdown uses literal * _ ` and straight quotes; disable "smart" subs.
        tv.smartQuotesType = .no
        tv.smartDashesType = .no
        tv.autocapitalizationType = .sentences
        tv.font = UIFont.systemFont(ofSize: fontSize)
        tv.text = text
        context.coordinator.textView = tv
        context.coordinator.highlight(tv)
        context.coordinator.observeKeyboard()
        controller.textView = tv
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        controller.textView = tv
        context.coordinator.textView = tv
        // External text change (e.g. document loaded / switched).
        if tv.text != text {
            let sel = tv.selectedRange
            tv.text = text
            tv.selectedRange = NSRange(
                location: min(sel.location, (text as NSString).length), length: 0)
            context.coordinator.highlight(tv)
        }
        if tv.font?.pointSize != fontSize {
            context.coordinator.fontSize = fontSize
            context.coordinator.highlight(tv)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, fontSize: fontSize)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        @Binding var text: String
        var fontSize: CGFloat
        weak var textView: UITextView?

        init(text: Binding<String>, fontSize: CGFloat) {
            self._text = text
            self.fontSize = fontSize
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        func highlight(_ tv: UITextView) {
            guard let storage = tv.textStorage as NSTextStorage? else { return }
            let highlighter = MarkdownHighlighter(baseSize: fontSize, traits: tv.traitCollection)
            let sel = tv.selectedRange
            highlighter.apply(to: storage)
            tv.selectedRange = sel
            // Keep new typing at the body baseline.
            tv.typingAttributes = [
                .font: UIFont.systemFont(ofSize: fontSize),
                .foregroundColor: UIColor.label,
            ]
        }

        func textViewDidChange(_ tv: UITextView) {
            text = tv.text
            highlight(tv)
        }

        // MARK: Smart list continuation

        /// When Return is pressed at the end of a list item, continue the list
        /// (new bullet / checkbox / next number); on an *empty* item, end the
        /// list instead by clearing the marker. Everything else falls through to
        /// the normal newline. Edits go through `replace` so they undo and fire
        /// the delegate (re-highlight + binding update).
        func textView(
            _ tv: UITextView, shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            guard text == "\n" else { return true }
            let ns = tv.text as NSString
            let lineRange = ns.lineRange(for: NSRange(location: range.location, length: 0))
            // Only the text from line start up to the caret matters.
            let prefixLen = range.location - lineRange.location
            guard prefixLen >= 0 else { return true }
            let line = ns.substring(with: NSRange(location: lineRange.location, length: prefixLen))

            guard let marker = ListMarker(line: line) else { return true }

            if marker.contentIsEmpty {
                // Empty item → break out of the list: remove the marker text.
                let clearRange = NSRange(
                    location: lineRange.location, length: prefixLen)
                if let start = tv.position(from: tv.beginningOfDocument, offset: clearRange.location),
                    let end = tv.position(from: start, offset: clearRange.length),
                    let tr = tv.textRange(from: start, to: end) {
                    tv.replace(tr, withText: "\n")
                }
                return false
            }

            if let sel = tv.selectedTextRange {
                tv.replace(sel, withText: "\n" + marker.next)
            }
            return false
        }

        // MARK: Keyboard avoidance

        func observeKeyboard() {
            let center = NotificationCenter.default
            center.addObserver(
                self, selector: #selector(keyboardChanged(_:)),
                name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
            center.addObserver(
                self, selector: #selector(keyboardHidden(_:)),
                name: UIResponder.keyboardWillHideNotification, object: nil)
        }

        @objc private func keyboardChanged(_ note: Notification) {
            guard let tv = textView, let window = tv.window,
                let frameValue = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue
            else { return }
            let kbInWindow = frameValue.cgRectValue
            let tvInWindow = tv.convert(tv.bounds, to: window)
            let overlap = max(0, tvInWindow.maxY - kbInWindow.minY)
            setBottomInset(overlap, on: tv)
        }

        @objc private func keyboardHidden(_ note: Notification) {
            guard let tv = textView else { return }
            setBottomInset(0, on: tv)
        }

        private func setBottomInset(_ bottom: CGFloat, on tv: UITextView) {
            guard tv.contentInset.bottom != bottom else { return }
            tv.contentInset.bottom = bottom
            tv.verticalScrollIndicatorInsets.bottom = bottom
            // Keep the caret in view once the inset settles.
            if bottom > 0 {
                tv.scrollRangeToVisible(tv.selectedRange)
            }
        }
    }
}

/// Parses the list marker of a source line so Return can continue it.
private struct ListMarker {
    /// The marker to insert on the *next* line (indent + bullet / next number).
    let next: String
    /// True when the current item has no content after its marker.
    let contentIsEmpty: Bool

    init?(line: String) {
        // Leading whitespace (indent) is preserved on the continued line.
        let indent = String(line.prefix { $0 == " " || $0 == "\t" })
        let body = String(line.dropFirst(indent.count))

        // Ordered list: "1. ", "2) " …
        if let dot = body.firstIndex(where: { $0 == "." || $0 == ")" }) {
            let numberPart = body[body.startIndex..<dot]
            let sepAndRest = body[body.index(after: dot)...]
            if !numberPart.isEmpty, numberPart.allSatisfy(\.isNumber),
                sepAndRest.first == " " {
                let sep = body[dot]
                let content = sepAndRest.dropFirst()
                let n = (Int(numberPart) ?? 0) + 1
                self.next = "\(indent)\(n)\(sep) "
                self.contentIsEmpty = content.trimmingCharacters(in: .whitespaces).isEmpty
                return
            }
        }

        // Unordered / task list: "- ", "* ", "+ ", "- [ ] ", "- [x] "
        guard let bullet = body.first, "-*+".contains(bullet),
            body.dropFirst().first == " " else { return nil }
        let afterBullet = body.dropFirst(2)  // past "- "
        if afterBullet.hasPrefix("[ ] ") || afterBullet.hasPrefix("[x] ")
            || afterBullet.hasPrefix("[X] ") {
            let content = afterBullet.dropFirst(4)
            self.next = "\(indent)\(bullet) [ ] "
            self.contentIsEmpty = content.trimmingCharacters(in: .whitespaces).isEmpty
        } else {
            self.next = "\(indent)\(bullet) "
            self.contentIsEmpty = afterBullet.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }
}

/// Imperative handle the SwiftUI keyboard toolbar uses to apply formatting to
/// the live `UITextView` (wrap the selection, prefix the line, insert a link).
/// Edits go through `replace(_:withText:)` so they participate in undo and fire
/// the delegate (re-highlighting + binding update).
final class EditorController: ObservableObject {
    weak var textView: UITextView?

    /// Wrap the current selection in `prefix`/`suffix`; if nothing is selected,
    /// insert the pair and place the cursor between them.
    func wrap(prefix: String, suffix: String) {
        guard let tv = textView, let range = tv.selectedTextRange else { return }
        let selected = tv.text(in: range) ?? ""
        tv.replace(range, withText: prefix + selected + suffix)
        if selected.isEmpty,
            let newStart = tv.position(from: range.start, offset: prefix.count) {
            tv.selectedTextRange = tv.textRange(from: newStart, to: newStart)
        }
        tv.becomeFirstResponder()
    }

    /// Ensure the current line starts with `marker` (headings, quotes, lists).
    func prefixLine(_ marker: String) {
        guard let tv = textView, let sel = tv.selectedTextRange else { return }
        let ns = tv.text as NSString
        let caret = tv.offset(from: tv.beginningOfDocument, to: sel.start)
        let lineStart = ns.lineRange(for: NSRange(location: caret, length: 0)).location
        if let pos = tv.position(from: tv.beginningOfDocument, offset: lineStart),
            let insertRange = tv.textRange(from: pos, to: pos) {
            tv.replace(insertRange, withText: marker)
        }
        tv.becomeFirstResponder()
    }

    func insert(_ string: String) {
        guard let tv = textView, let range = tv.selectedTextRange else { return }
        tv.replace(range, withText: string)
        tv.becomeFirstResponder()
    }

    /// Place the cursor at the end and focus — used when jumping into a note via
    /// the Quick Note widget or "Open With".
    func moveToEnd() {
        guard let tv = textView else { return }
        tv.becomeFirstResponder()
        let end = tv.endOfDocument
        tv.selectedTextRange = tv.textRange(from: end, to: end)
        tv.scrollRangeToVisible(NSRange(location: (tv.text as NSString).length, length: 0))
    }
}
