import SwiftUI
import UIKit

/// Colors and metrics for Markdown highlighting and preview, resolved against
/// the current light/dark trait (like the app's HSL variables in `index.css`).
enum MarkdownTheme {
    static let accent = UIColor(red: 0.29, green: 0.44, blue: 0.95, alpha: 1) // ~hsl(225,89%,62%)

    static func heading(_ traits: UITraitCollection) -> UIColor { .label }
    static func body(_ traits: UITraitCollection) -> UIColor { .label }
    static func secondary(_ traits: UITraitCollection) -> UIColor { .secondaryLabel }

    /// Dimmed color for Markdown syntax markers (`#`, `*`, backticks, list
    /// bullets) so the prose stands out — the iA Writer / Bear look.
    static func syntaxMarker(_ traits: UITraitCollection) -> UIColor { .tertiaryLabel }

    static func code(_ traits: UITraitCollection) -> UIColor {
        UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(red: 0.55, green: 0.85, blue: 0.65, alpha: 1)
                : UIColor(red: 0.15, green: 0.45, blue: 0.30, alpha: 1)
        }
    }

    static func codeBackground(_ traits: UITraitCollection) -> UIColor {
        UIColor { tc in
            tc.userInterfaceStyle == .dark
                ? UIColor(white: 1, alpha: 0.08)
                : UIColor(white: 0, alpha: 0.05)
        }
    }

    static let link = accent
}
