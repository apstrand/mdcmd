import { convertFileSrc } from "@tauri-apps/api/core";
import { Eye, Image as ImageIcon, Video as VideoIcon } from "lucide-react";

interface MediaViewerProps {
  filePath: string;
}

export default function MediaViewer({ filePath }: MediaViewerProps) {
  const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(filePath);
  const isVideo = /\.(mp4|webm|ogg|mov|mkv)$/i.test(filePath);

  const getFileName = (path: string) => {
    const isWindows = path.includes("\\");
    const separator = isWindows ? "\\" : "/";
    return path.substring(path.lastIndexOf(separator) + 1);
  };

  const assetUrl = convertFileSrc(filePath);

  return (
    <div className="main-panel">
      {/* File Info Header */}
      <div className="editor-header">
        <div className="file-info" style={{ borderBottom: "none" }}>
          <div className="file-title-container">
            {isImage ? (
              <ImageIcon className="w-5 h-5 text-accent" />
            ) : (
              <VideoIcon className="w-5 h-5 text-accent" />
            )}
            <div>
              <div className="file-name-text">{getFileName(filePath)}</div>
              <div className="file-path-text">{filePath}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                color: "var(--text-secondary)",
                backgroundColor: "var(--bg-tertiary)",
                padding: "4px 8px",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                fontWeight: 500,
              }}
            >
              <Eye className="w-3.5 h-3.5" /> View Only
            </span>
          </div>
        </div>
      </div>

      {/* Main Preview Container */}
      <div
        style={{
          flexGrow: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "var(--bg-secondary)",
          padding: "24px",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 8px 30px rgba(0, 0, 0, 0.08)",
            borderRadius: "6px",
            overflow: "hidden",
            backgroundColor: "var(--bg-primary)",
            border: "1px solid var(--border)",
          }}
        >
          {isImage && (
            <img
              src={assetUrl}
              alt={getFileName(filePath)}
              style={{
                maxWidth: "100%",
                maxHeight: "80vh",
                objectFit: "contain",
                display: "block",
              }}
            />
          )}

          {isVideo && (
            <video
              src={assetUrl}
              controls
              style={{
                maxWidth: "100%",
                maxHeight: "80vh",
                display: "block",
                backgroundColor: "black",
              }}
            />
          )}

          {!isImage && !isVideo && (
            <div style={{ padding: "40px", color: "var(--text-secondary)" }}>
              Unsupported media type.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
