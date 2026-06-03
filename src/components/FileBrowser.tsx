import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Folder,
  FileText,
  ChevronLeft,
  Loader2,
  AlertCircle,
  Pin,
  X,
} from "lucide-react";

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

  // Initialize pinned workspaces state from localStorage
  const [pinnedWorkspaces, setPinnedWorkspaces] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("tauri-markdown-workspaces");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Persist workspaces in localStorage
  useEffect(() => {
    localStorage.setItem("tauri-markdown-workspaces", JSON.stringify(pinnedWorkspaces));
  }, [pinnedWorkspaces]);

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
      if (parts[parts.length - 1] === "") {
        parts.pop();
      }
      parts.pop();
      
      let parent = parts.join(separator);
      if (parent === "" && !isWindows) {
        parent = "/";
      }
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
      return currentPath.split("\\").filter(Boolean).length > 1;
    } else {
      return currentPath !== "/";
    }
  };

  // Extract folder name from absolute path
  const getFolderName = (path: string) => {
    const isWindows = path.includes("\\");
    const separator = isWindows ? "\\" : "/";
    if (path === "/" || (isWindows && path.endsWith(":\\"))) {
      return path;
    }
    const parts = path.split(separator).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : path;
  };

  // Pin a folder
  const handlePin = (path: string) => {
    if (!pinnedWorkspaces.includes(path)) {
      setPinnedWorkspaces([...pinnedWorkspaces, path]);
    }
  };

  // Unpin a folder
  const handleUnpin = (path: string) => {
    setPinnedWorkspaces(pinnedWorkspaces.filter((p) => p !== path));
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <Folder className="w-4 h-4 text-accent" />
        <span>Workspace Hub</span>
      </div>

      {/* Workspaces Section (Upper Sidebar) */}
      <div className="sidebar-section workspace">
        <div className="sidebar-subheader">
          <span className="sidebar-section-title">
            <Pin className="w-3.5 h-3.5 text-accent" style={{ transform: "rotate(45deg)" }} />
            <span>Workspaces</span>
          </span>
        </div>
        <div className="sidebar-scroll-content">
          {pinnedWorkspaces.length === 0 ? (
            <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)", opacity: 0.7 }}>
              No pinned workspace folders.
            </div>
          ) : (
            <div className="workspace-list">
              {pinnedWorkspaces.map((path) => (
                <div
                  key={path}
                  className="workspace-item"
                  onClick={() => setCurrentPath(path)}
                  title={path}
                >
                  <div className="workspace-item-info">
                    <Folder className="workspace-item-icon" style={{ width: "15px", height: "15px", fill: "var(--accent-soft)", color: "var(--accent)", minWidth: "15px" }} />
                    <div className="workspace-item-text">
                      <span className="workspace-item-name">{getFolderName(path)}</span>
                      <span className="workspace-item-path">{path}</span>
                    </div>
                  </div>
                  <div className="workspace-item-actions">
                    <button
                      className="workspace-action-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUnpin(path);
                      }}
                      title="Unpin folder"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Folders Section (Lower Sidebar) */}
      <div className="sidebar-section folders">
        <div className="sidebar-subheader">
          <span className="sidebar-section-title">
            <Folder className="w-3.5 h-3.5 text-secondary" />
            <span>Folders</span>
          </span>
          {currentPath && (
            <button
              className="file-action-btn"
              onClick={() => {
                if (pinnedWorkspaces.includes(currentPath)) {
                  handleUnpin(currentPath);
                } else {
                  handlePin(currentPath);
                }
              }}
              title={pinnedWorkspaces.includes(currentPath) ? "Unpin current folder" : "Pin current folder"}
              style={{ opacity: 0.8 }}
            >
              <Pin
                className={`w-3.5 h-3.5 ${pinnedWorkspaces.includes(currentPath) ? "pinned text-accent fill-accent" : ""}`}
                style={{
                  transform: pinnedWorkspaces.includes(currentPath) ? "none" : "rotate(45deg)",
                }}
              />
            </button>
          )}
        </div>
        <div className="sidebar-scroll-content">
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
                  const isPinned = pinnedWorkspaces.includes(entry.path);
                  
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

                      {entry.is_dir && (
                        <div className="file-item-actions">
                          <button
                            className={`file-action-btn ${isPinned ? "pinned" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isPinned) {
                                handleUnpin(entry.path);
                              } else {
                                handlePin(entry.path);
                              }
                            }}
                            title={isPinned ? "Remove from Workspaces" : "Pin to Workspaces"}
                          >
                            <Pin
                              className="w-3.5 h-3.5"
                              style={{
                                transform: isPinned ? "none" : "rotate(45deg)",
                              }}
                            />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
