import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import FileBrowser from "./components/FileBrowser";
import MarkdownEditor from "./components/MarkdownEditor";
import MediaViewer from "./components/MediaViewer";
import { FileCode, Loader2 } from "lucide-react";

export default function App() {
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [isLoadingFile, setIsLoadingFile] = useState(false);

  // Check if a file is an image or video
  const isMediaFile = (path: string) => {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|webm|ogg|mov|mkv)$/i.test(path);
  };

  // Load a file's content from local disk
  const handleSelectFile = async (filePath: string) => {
    if (isMediaFile(filePath)) {
      setSelectedFile(filePath);
      setFileContent("");
      return;
    }

    setIsLoadingFile(true);
    try {
      const content = await invoke<string>("read_file_content", { path: filePath });
      setFileContent(content);
      setSelectedFile(filePath);
    } catch (err) {
      alert(`Error reading file: ${err}`);
    } finally {
      setIsLoadingFile(false);
    }
  };

  // Write content back to the local file
  const handleSaveFile = async (content: string) => {
    if (!selectedFile) return;
    try {
      await invoke("write_file_content", {
        path: selectedFile,
        content,
      });
      setFileContent(content);
    } catch (err) {
      alert(`Error saving file: ${err}`);
      throw err;
    }
  };

  return (
    <div className="app-container">
      {/* File Browser Sidebar */}
      <FileBrowser
        currentPath={currentPath}
        setCurrentPath={setCurrentPath}
        selectedFile={selectedFile}
        onSelectFile={handleSelectFile}
      />

      {/* Editor, Viewer, or Landing State */}
      <div style={{ flexGrow: 1, display: "flex", height: "100%", overflow: "hidden" }}>
        {isLoadingFile ? (
          <div className="no-file-selected">
            <Loader2 className="w-10 h-10 animate-spin text-accent" style={{ marginBottom: "16px" }} />
            <p>Loading file content...</p>
          </div>
        ) : selectedFile ? (
          isMediaFile(selectedFile) ? (
            <MediaViewer filePath={selectedFile} />
          ) : (
            <MarkdownEditor
              filePath={selectedFile}
              initialContent={fileContent}
              onSave={handleSaveFile}
            />
          )
        ) : (
          <div className="no-file-selected">
            <FileCode className="no-file-icon text-accent" style={{ width: "64px", height: "64px" }} />
            <h2 style={{ margin: "0 0 8px 0", fontWeight: 600, fontSize: "20px" }}>No File Open</h2>
            <p style={{ margin: 0, fontSize: "14px", opacity: 0.8, maxWidth: "320px" }}>
              Select a Markdown (.md), image, or video file from the browser sidebar to open. Use Cmd+S/Ctrl+S to save markdown.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
