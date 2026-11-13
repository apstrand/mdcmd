import SwiftUI
import AVKit

/// Full-screen image / video viewer, the native counterpart of
/// `src/components/MediaViewer.tsx`. Images support pinch-zoom and pan; videos
/// use the system player.
struct MediaView: View {
    let entry: FileEntry

    /// The URL actually handed to the image/video view. For local files it's the
    /// entry's own file URL; for GitHub the bytes are fetched and written to a
    /// temp file (`AVPlayer`/`UIImage` can't carry an auth header to a remote).
    @State private var localURL: URL?
    @State private var loadError: String?

    var body: some View {
        Group {
            if let loadError {
                ContentUnavailableView(
                    "Can't Load Media", systemImage: "exclamationmark.triangle",
                    description: Text(loadError))
            } else if let localURL {
                switch entry.kind {
                case .video:
                    VideoPlayer(player: AVPlayer(url: localURL))
                        .ignoresSafeArea(edges: .bottom)
                default:
                    ZoomableImage(url: localURL)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .background(Color(.systemBackground))
        .task(id: entry.id) { await resolve() }
    }

    private func resolve() async {
        if !entry.url.isGitHub {
            localURL = entry.url
            return
        }
        do {
            let data = try await GitHubService.shared.rawData(entry.url)
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString + "-" + entry.name)
            try data.write(to: tmp)
            localURL = tmp
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// A pinch-to-zoom / drag-to-pan image, reset on double-tap.
private struct ZoomableImage: View {
    let url: URL
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        if let image = UIImage(contentsOfFile: url.path) {
            GeometryReader { _ in
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .offset(offset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .gesture(
                        MagnificationGesture()
                            .onChanged { value in scale = max(1, lastScale * value) }
                            .onEnded { _ in lastScale = scale }
                    )
                    .simultaneousGesture(
                        DragGesture()
                            .onChanged { value in
                                guard scale > 1 else { return }
                                offset = CGSize(
                                    width: lastOffset.width + value.translation.width,
                                    height: lastOffset.height + value.translation.height)
                            }
                            .onEnded { _ in lastOffset = offset }
                    )
                    .onTapGesture(count: 2) {
                        withAnimation(.spring) {
                            scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero
                        }
                    }
            }
        } else {
            ContentUnavailableView("Can't Display Image", systemImage: "photo")
        }
    }
}
