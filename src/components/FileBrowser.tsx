import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, FileText, ChevronLeft, Loader2, AlertCircle } from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface FileBrowserProps {
  currentPath: string;
  setCurrentPath: (path: string) => void;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}

export default function FileBrowser({
  currentPath,
  setCurrentPath,
  selectedFile,
  onSelectFile,
}: FileBrowserProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize path to home directory if empty
  useEffect(() => {
    if (!currentPath) {
      setLoading(true);
      invoke<string>("get_home_dir")
        .then((home) => {
          setCurrentPath(home);
        })
        .catch((err) => {
          setError(String(err));
          setLoading(false);
        });
    }
  }, [currentPath, setCurrentPath]);

  // Load directory contents when current path changes
  useEffect(() => {
    if (!currentPath) return;

    let active = true;
    setLoading(true);
    setError(null);

    invoke<FileEntry[]>("list_directory", { path: currentPath })
      .then((data) => {
        if (active) {
          setEntries(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(String(err));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [currentPath]);

  // Go to parent directory
  const handleGoUp = () => {
    if (!currentPath) return;
    const isWindows = currentPath.includes("\\");
    const separator = isWindows ? "\\" : "/";
    const parts = currentPath.split(separator);
    
    if (parts.length > 1) {
      // Remove trailing separator/empty elements
      if (parts[parts.length - 1] === "") {
        parts.pop();
      }
      parts.pop();
      
      let parent = parts.join(separator);
      // For Unix root
      if (parent === "" && !isWindows) {
        parent = "/";
      }
      // For Windows drive root (e.g. C:)
      if (isWindows && parent.endsWith(":")) {
        parent = parent + "\\";
      }
      
      setCurrentPath(parent || separator);
    }
  };

  // Determine if we can go up further
  const canGoUp = () => {
    if (!currentPath) return false;
    const isWindows = currentPath.includes("\\");
    if (isWindows) {
      // e.g. C:\ shouldn't go up
      return currentPath.split("\\").filter(Boolean).length > 1;
    } else {
      // Unix / shouldn't go up
      return currentPath !== "/";
    }
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <Folder className="w-4 h-4 text-accent" />
        <span>File Browser</span>
      </div>

      <div className="sidebar-content">
        <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
          <button
            className="nav-button"
            onClick={handleGoUp}
            disabled={!canGoUp() || loading}
            title="Go Up"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="path-bar" title={currentPath}>
            {currentPath || "Loading path..."}
          </div>
        </div>

        {loading && (
          <div style={{ display: "flex", justifyContent: "center", padding: "20px" }}>
            <Loader2 className="w-6 h-6 animate-spin text-secondary" style={{ opacity: 0.6 }} />
          </div>
        )}

        {error && (
          <div style={{ padding: "12px", display: "flex", gap: "8px", color: "hsl(0, 84%, 60%)", fontSize: "12px", background: "hsl(0, 84%, 97%)", borderRadius: "6px", border: "1px solid hsl(0, 84%, 90%)" }}>
            <AlertCircle className="w-4 h-4 min-w-[16px]" />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && (
          <div className="file-list">
            {entries.length === 0 ? (
              <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)" }}>
                Empty Directory
              </div>
            ) : (
              entries.map((entry) => {
                const isMarkdown = entry.name.toLowerCase().endsWith(".md");
                const isSelected = selectedFile === entry.path;
                
                return (
                  <div
                    key={entry.path}
                    className={`file-item ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      if (entry.is_dir) {
                        setCurrentPath(entry.path);
                      } else if (isMarkdown) {
                        onSelectFile(entry.path);
                      }
                    }}
                    style={{
                      opacity: !entry.is_dir && !isMarkdown ? 0.45 : 1,
                      cursor: !entry.is_dir && !isMarkdown ? "default" : "pointer",
                    }}
                  >
                    <span className="file-item-icon">
                      {entry.is_dir ? (
                        <Folder style={{ width: "16px", height: "16px", fill: "var(--text-secondary)", opacity: 0.8 }} />
                      ) : (
                        <FileText style={{ width: "16px", height: "16px" }} />
                      )}
                    </span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flexGrow: 1,
                      }}
                    >
                      {entry.name}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
