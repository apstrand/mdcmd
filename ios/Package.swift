// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Mdcmd",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        // The main app. `product: Mdcmd` in xtool.yml selects this as the app;
        // the widget below is embedded via xtool.yml's `extensions`.
        .library(
            name: "Mdcmd",
            targets: ["Mdcmd"]
        ),
        // WidgetKit extension bundled into the app.
        .library(
            name: "QuickNoteWidget",
            targets: ["QuickNoteWidget"]
        ),
    ],
    targets: [
        // Pure-Swift app target — no external dependencies, so the CI build
        // (`xtool dev build`) stays hermetic. Markdown highlighting and preview
        // rendering are implemented natively in Sources/Mdcmd/Markdown.
        .target(
            name: "Mdcmd",
            swiftSettings: [
                // UI-centric app code; Swift 5 language mode keeps strict
                // concurrency out of the way (main-actor UI, no shared mutable
                // state across threads).
                .swiftLanguageMode(.v5),
            ]
        ),
        .target(
            name: "QuickNoteWidget",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
