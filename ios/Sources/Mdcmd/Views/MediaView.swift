import SwiftUI
import AVKit

/// Full-screen image / video viewer, the native counterpart of
/// `src/components/MediaViewer.tsx`. Images support pinch-zoom and pan; videos
/// use the system player.
struct MediaView: View {
    let entry: FileEntry

    var body: some View {
        Group {
            switch entry.kind {
            case .video:
                VideoPlayer(player: AVPlayer(url: entry.url))
                    .ignoresSafeArea(edges: .bottom)
            default:
                ZoomableImage(url: entry.url)
            }
        }
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .background(Color(.systemBackground))
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
