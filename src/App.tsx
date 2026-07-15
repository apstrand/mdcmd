import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileBrowser from "./components/FileBrowser";
import MarkdownEditor from "./components/MarkdownEditor";
import MediaViewer from "./components/MediaViewer";
import TerminalPane from "./components/TerminalPane";
import { storage } from "./storage";
import { displayRelativePath } from "./utils/paths";
import { FileCode, Loader2, X, AlertCircle, RefreshCw, Copy, Type, ChevronLeft } from "lucide-react";

// True for the desktop (Tauri) build; false for the static web / Dropbox build.
const isDesktop = storage.id === "tauri";

export default function App() {
  const [currentPath, setCurrentPath] = useState("");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [openTabs, setOpenTabs] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem("tauri-markdown-open-tabs");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [selectedFile, setSelectedFile] = useState<string | null>(() => {
    try {
      return localStorage.getItem("tauri-markdown-selected-file");
    } catch {
      return null;
    }
  });
  const [filesData, setFilesData] = useState<Record<string, { savedContent: string, currentContent: string }>>({});
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [draggedTab, setDraggedTab] = useState<string | null>(null);

  const [isTerminalOpen, setIsTerminalOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("tauri-markdown-terminal-open") === "true";
    } catch {
      return false;
    }
  });
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("tauri-markdown-terminal-height");
      return saved ? parseInt(saved, 10) : 280;
    } catch {
      return 280;
    }
  });

  useEffect(() => {
    localStorage.setItem("tauri-markdown-terminal-open", String(isTerminalOpen));
  }, [isTerminalOpen]);

  useEffect(() => {
    localStorage.setItem("tauri-markdown-terminal-height", String(terminalHeight));
  }, [terminalHeight]);

  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void | Promise<void>;
    onDiscard?: () => void | Promise<void>;
    onCancel?: () => void;
  } | null>(null);

  const filesDataRef = useRef(filesData);
  useEffect(() => {
    filesDataRef.current = filesData;
  }, [filesData]);

  const selectedFileRef = useRef(selectedFile);
  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  const handleCloseTabRef = useRef<(path: string) => void>(() => {});
  useEffect(() => {
    handleCloseTabRef.current = handleCloseTab;
  });

  useEffect(() => {
    if (!storage.capabilities.updater) return;
    const timer = setTimeout(async () => {
      try {
        const version = await invoke<string | null>("check_for_updates");
        if (version) setUpdateVersion(version);
      } catch {
        // updater not available in dev or network error — silent
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem("tauri-markdown-open-tabs", JSON.stringify(openTabs));
  }, [openTabs]);

  useEffect(() => {
    if (selectedFile) {
      localStorage.setItem("tauri-markdown-selected-file", selectedFile);
    } else {
      localStorage.removeItem("tauri-markdown-selected-file");
    }
  }, [selectedFile]);

  // Load initial active file content on mount
  useEffect(() => {
    const savedSelected = localStorage.getItem("tauri-markdown-selected-file");
    if (savedSelected) {
      handleSelectFile(savedSelected);
    }
  }, []);

  // Intercept application window close to check for unsaved changes (desktop only)
  useEffect(() => {
    if (!isDesktop) return;
    const appWindow = getCurrentWindow();
    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      // Always prevent default and manage the window lifecycle explicitly,
      // because Tauri v2 does not reliably close the window otherwise.
      event.preventDefault();

      const currentFilesData = filesDataRef.current;
      const dirtyFiles = Object.entries(currentFilesData).filter(
        ([_, data]) => data.savedContent !== data.currentContent
      );

      if (dirtyFiles.length > 0) {
        setConfirmDialog({
          isOpen: true,
          title: "Unsaved Changes",
          message: dirtyFiles.length === 1
            ? `"${getFileName(dirtyFiles[0][0])}" has unsaved changes. Do you want to save them before quitting?`
            : `You have unsaved changes in ${dirtyFiles.length} files. Do you want to save them before quitting?`,
          onConfirm: async () => {
            try {
              await Promise.all(
                dirtyFiles.map(async ([path, data]) => {
                  await storage.writeFile(path, data.currentContent);
                })
              );
              await getCurrentWindow().destroy();
            } catch (err) {
              alert(`Error saving files: ${err}`);
            }
          },
          onDiscard: async () => {
            await getCurrentWindow().destroy();
          },
          onCancel: () => {
            // Stay in app
          }
        });
      } else {
        await appWindow.destroy();
      }
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  interface PinnedItem {
    path: string;
    isDir: boolean;
  }

  // Pinned workspaces are shared with the CLI/TUI via the mdcmd config file.
  const [pinnedWorkspaces, setPinnedWorkspaces] = useState<PinnedItem[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);

  // Load workspaces from the shared config on mount, migrating any legacy
  // localStorage workspaces into the shared config on first run.
  //
  // On iOS the pinned workspaces are folders reached through the native document
  // picker; their access is granted via security-scoped bookmarks that must be
  // re-activated on each launch. Do that first so listing a restored folder
  // works, then load the workspaces.
  useEffect(() => {
    Promise.resolve(storage.restoreAccess?.())
      .catch((err) => console.error("Failed to restore folder access:", err))
      .finally(() => {
    storage.readWorkspaces()
      .then((items) => {
        if (items.length === 0) {
          try {
            const legacy = localStorage.getItem("tauri-markdown-workspaces");
            if (legacy) {
              const parsed = JSON.parse(legacy);
              const migrated: PinnedItem[] = parsed.map((item: any) =>
                typeof item === "string" ? { path: item, isDir: true } : item
              );
              if (migrated.length > 0) {
                setPinnedWorkspaces(migrated);
                localStorage.removeItem("tauri-markdown-workspaces");
                return;
              }
            }
          } catch {
            // ignore malformed legacy data
          }
        }
        setPinnedWorkspaces(items);
      })
      .catch((err) => console.error("Failed to load workspaces:", err))
      .finally(() => setWorkspacesLoaded(true));
      });
  }, []);

  // Persist workspaces back to the shared config whenever they change.
  useEffect(() => {
    if (!workspacesLoaded) return;
    storage.writeWorkspaces(pinnedWorkspaces).catch((err) =>
      console.error("Failed to save workspaces:", err)
    );
  }, [pinnedWorkspaces, workspacesLoaded]);

  const sortedPinned = useMemo(() => {
    return [...pinnedWorkspaces].sort((a, b) => {
      if (a.isDir && !b.isDir) return 1;
      if (!a.isDir && b.isDir) return -1;
      return a.path.localeCompare(b.path);
    });
  }, [pinnedWorkspaces]);

  const [viewMode, setViewMode] = useState<"list" | "tree">(() => {
    try {
      const saved = localStorage.getItem("tauri-markdown-view-mode");
      return (saved === "tree" || saved === "list") ? saved : "list";
    } catch {
      return "list";
    }
  });

  useEffect(() => {
    localStorage.setItem("tauri-markdown-view-mode", viewMode);
  }, [viewMode]);

  // Persistent sidebar width state
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("tauri-markdown-sidebar-width");
      return saved ? parseInt(saved, 10) : 260;
    } catch {
      return 260;
    }
  });

  useEffect(() => {
    localStorage.setItem("tauri-markdown-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  // Handle drag resizing for the sidebar
  const startSidebarResize = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(180, Math.min(450, moveEvent.clientX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  // Check if a file is an image or video
  const isMediaFile = (path: string) => {
    return /\.(png|jpe?g|gif|webp|svg|bmp|ico|mp4|webm|ogg|mov|mkv)$/i.test(path);
  };

  // Load a file's content from local disk
  const handleSelectFile = async (filePath: string) => {
    setFileError(null);

    // Automatically sync parent folder view
    const isWindows = filePath.includes("\\");
    const separator = isWindows ? "\\" : "/";
    const lastSep = filePath.lastIndexOf(separator);
    if (lastSep !== -1) {
      const parentDir = filePath.substring(0, lastSep);
      setCurrentPath(parentDir);
    }

    // Add to open tabs list
    setOpenTabs(prev => prev.includes(filePath) ? prev : [...prev, filePath]);

    if (isMediaFile(filePath)) {
      setSelectedFile(filePath);
      return;
    }

    if (filesData[filePath]) {
      setSelectedFile(filePath);
      return;
    }

    setIsLoadingFile(true);
    try {
      const content = await storage.readFile(filePath);
      setFilesData(prev => ({
        ...prev,
        [filePath]: { savedContent: content, currentContent: content }
      }));
      setSelectedFile(filePath);
    } catch (err) {
      setFileError(String(err));
      setSelectedFile(filePath);
    } finally {
      setIsLoadingFile(false);
    }
  };

  // Close tab and cycle active tab selection
  const handleCloseTab = (pathToRemove: string) => {
    const isDirty = filesData[pathToRemove] && filesData[pathToRemove].savedContent !== filesData[pathToRemove].currentContent;
    
    const proceedWithClose = () => {
      const updatedTabs = openTabs.filter((t) => t !== pathToRemove);
      setOpenTabs(updatedTabs);

      setFilesData(prev => {
        const next = { ...prev };
        delete next[pathToRemove];
        return next;
      });

      if (selectedFile === pathToRemove) {
        if (updatedTabs.length > 0) {
          const index = openTabs.indexOf(pathToRemove);
          const nextIndex = Math.min(index, updatedTabs.length - 1);
          handleSelectFile(updatedTabs[nextIndex]);
        } else {
          setSelectedFile(null);
          setFileError(null);
        }
      }
    };

    if (isDirty) {
      setConfirmDialog({
        isOpen: true,
        title: "Unsaved Changes",
        message: `"${getFileName(pathToRemove)}" has unsaved changes. Do you want to save them before closing?`,
        onConfirm: async () => {
          try {
            const content = filesData[pathToRemove].currentContent;
            await handleSaveFile(pathToRemove, content);
            proceedWithClose();
          } catch (err) {
            console.error("Failed to save before closing:", err);
          }
        },
        onDiscard: () => {
          proceedWithClose();
        },
        onCancel: () => {
          // Do nothing
        }
      });
    } else {
      proceedWithClose();
    }
  };

  // Get filename from absolute path
  const getFileName = (path: string) => {
    const isWindows = path.includes("\\");
    const separator = isWindows ? "\\" : "/";
    return path.substring(path.lastIndexOf(separator) + 1);
  };

  // Copy text (path or name) of the active file to the clipboard
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFeedback(`Copied ${label}`);
      setTimeout(() => setCopyFeedback(null), 1500);
    } catch (err) {
      console.error("Clipboard copy failed:", err);
    }
  };

  // Write content back to the local file
  const handleSaveFile = async (filePath: string, content: string) => {
    try {
      await storage.writeFile(filePath, content);
      setFilesData(prev => ({
        ...prev,
        [filePath]: { savedContent: content, currentContent: content }
      }));
    } catch (err) {
      alert(`Error saving file: ${err}`);
      throw err;
    }
  };

  const handleContentChange = (filePath: string, newContent: string) => {
    setFilesData(prev => {
      const existing = prev[filePath];
      if (!existing || existing.currentContent === newContent) return prev;
      return {
        ...prev,
        [filePath]: { ...existing, currentContent: newContent }
      };
    });
  };

  const handleSaveAll = async () => {
    const dirtyFiles = Object.entries(filesData).filter(
      ([_, data]) => data.savedContent !== data.currentContent
    );
    if (dirtyFiles.length === 0) return;
    try {
      await Promise.all(
        dirtyFiles.map(async ([path, data]) => {
          await storage.writeFile(path, data.currentContent);
        })
      );
      setFilesData(prev => {
        const next = { ...prev };
        dirtyFiles.forEach(([path, data]) => {
          next[path] = { savedContent: data.currentContent, currentContent: data.currentContent };
        });
        return next;
      });
    } catch (err) {
      alert(`Error saving all files: ${err}`);
    }
  };

  const handleSaveAllRef = useRef(handleSaveAll);
  useEffect(() => {
    handleSaveAllRef.current = handleSaveAll;
  });

  // Keyboard shortcut Cmd+W / Ctrl+W to close the active tab
  useEffect(() => {
    const handleCmdW = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "w") {
        e.preventDefault();
        const file = selectedFileRef.current;
        if (file) handleCloseTabRef.current(file);
      }
    };
    window.addEventListener("keydown", handleCmdW);
    return () => window.removeEventListener("keydown", handleCmdW);
  }, []);

  // Keyboard shortcut Cmd+Shift+C / Ctrl+Shift+C to copy the active file's path
  useEffect(() => {
    const handleCopyPath = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "c") {
        const file = selectedFileRef.current;
        if (file) {
          e.preventDefault();
          copyToClipboard(file, "path");
        }
      }
    };
    window.addEventListener("keydown", handleCopyPath);
    return () => window.removeEventListener("keydown", handleCopyPath);
  }, []);

  // Keyboard shortcut Cmd+Alt+S / Ctrl+Alt+S to save all dirty files
  useEffect(() => {
    const handleSaveAllShortcut = (e: KeyboardEvent) => {
      const isCmd = e.metaKey || e.ctrlKey;
      const isAlt = e.altKey;
      if (isCmd && isAlt && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSaveAllRef.current();
      }
    };
    window.addEventListener("keydown", handleSaveAllShortcut);
    return () => window.removeEventListener("keydown", handleSaveAllShortcut);
  }, []);

  // Keyboard shortcuts Cmd+Shift+[ and Cmd+Shift+] to change tabs
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isCmdShift = (e.metaKey || e.ctrlKey) && e.shiftKey;
      if (!isCmdShift) return;

      if (e.key === "[" || e.key === "{" || e.code === "BracketLeft") {
        e.preventDefault();
        if (openTabs.length > 1 && selectedFile) {
          const idx = openTabs.indexOf(selectedFile);
          if (idx !== -1) {
            const prevIdx = (idx - 1 + openTabs.length) % openTabs.length;
            handleSelectFile(openTabs[prevIdx]);
          }
        }
      } else if (e.key === "]" || e.key === "}" || e.code === "BracketRight") {
        e.preventDefault();
        if (openTabs.length > 1 && selectedFile) {
          const idx = openTabs.indexOf(selectedFile);
          if (idx !== -1) {
            const nextIdx = (idx + 1) % openTabs.length;
            handleSelectFile(openTabs[nextIdx]);
          }
        }
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [openTabs, selectedFile]);

  // Keyboard shortcuts Cmd-1..9 (tabs) and Cmd-Shift-1..9 (workspaces)
  useEffect(() => {
    const handleNumberShortcuts = (e: KeyboardEvent) => {
      const isCmd = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      
      const num = parseInt(e.key, 10);
      if (isNaN(num) || num < 1 || num > 9) return;

      const index = num - 1;

      if (isCmd && isShift) {
        e.preventDefault();
        if (index < sortedPinned.length) {
          const item = sortedPinned[index];
          if (item.isDir) {
            setCurrentPath(item.path);
          } else {
            handleSelectFile(item.path);
          }
        }
      } else if (isCmd) {
        e.preventDefault();
        if (index < openTabs.length) {
          handleSelectFile(openTabs[index]);
        }
      }
    };

    window.addEventListener("keydown", handleNumberShortcuts);
    return () => window.removeEventListener("keydown", handleNumberShortcuts);
  }, [openTabs, sortedPinned]);

  // Keyboard shortcut Ctrl+` to toggle the terminal panel
  useEffect(() => {
    if (!storage.capabilities.terminal) return;
    const handleToggleTerminal = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        setIsTerminalOpen(prev => !prev);
      }
    };
    window.addEventListener("keydown", handleToggleTerminal);
    return () => window.removeEventListener("keydown", handleToggleTerminal);
  }, []);

  // Handle drag resizing for the terminal panel
  const startTerminalResize = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    const startHeight = terminalHeight;
    const startY = mouseDownEvent.clientY;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const newHeight = Math.max(120, Math.min(window.innerHeight - 200, startHeight - deltaY));
      setTerminalHeight(newHeight);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleDragStart = (e: React.DragEvent, path: string) => {
    setDraggedTab(path);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    if (!draggedTab || draggedTab === targetPath) return;

    // Reorder openTabs
    const draggedIndex = openTabs.indexOf(draggedTab);
    const targetIndex = openTabs.indexOf(targetPath);
    if (draggedIndex !== -1 && targetIndex !== -1) {
      const newTabs = [...openTabs];
      newTabs.splice(draggedIndex, 1);
      newTabs.splice(targetIndex, 0, draggedTab);
      setOpenTabs(newTabs);
    }
  };

  const handleDragEnd = () => {
    setDraggedTab(null);
  };

  // On narrow (phone) viewports the layout collapses to a single pane via CSS
  // media queries; `has-file` tells the stylesheet to swap the file browser for
  // the editor once a file is open.
  const showEditor = Boolean(selectedFile) || isLoadingFile;

  return (
    <div className={`app-container${showEditor ? " has-file" : ""}`}>
      {/* File Browser Sidebar */}
      <FileBrowser
        currentPath={currentPath}
        setCurrentPath={setCurrentPath}
        selectedFile={selectedFile}
        onSelectFile={handleSelectFile}
        width={sidebarWidth}
        pinnedWorkspaces={pinnedWorkspaces}
        setPinnedWorkspaces={setPinnedWorkspaces}
        sortedPinned={sortedPinned}
        viewMode={viewMode}
        setViewMode={setViewMode}
      />

      {/* Vertical Drag Resizer Handle */}
      <div className="sidebar-resizer" onMouseDown={startSidebarResize} />

      {/* Editor/Viewer Panel with Tabs Bar */}
      <div className="editor-panel" style={{ flexGrow: 1, display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {/* On mobile the sidebar is hidden while a file is open, so offer a way
            back to the file browser (tabs are preserved). Hidden on desktop and
            when no file is open via CSS. */}
        <button
          className="mobile-back-btn"
          onClick={() => setSelectedFile(null)}
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Files</span>
        </button>
        {/* Update notification banner */}
        {updateVersion && !updateDismissed && (
          <div className="update-banner">
            <RefreshCw className="w-4 h-4" style={{ flexShrink: 0 }} />
            <span>Update v{updateVersion} available</span>
            <button
              className="update-install-btn"
              disabled={isInstalling}
              onClick={async () => {
                setIsInstalling(true);
                try {
                  await invoke("download_and_install_update");
                } catch (err) {
                  alert(`Update failed: ${err}`);
                  setIsInstalling(false);
                }
              }}
            >
              {isInstalling ? "Installing…" : "Install & Restart"}
            </button>
            <button className="update-dismiss-btn" onClick={() => setUpdateDismissed(true)}>
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        {/* Tabs Bar Container */}
        {openTabs.length > 0 && (
          <div className="tabs-container">
            <div className="tabs-bar">
              {openTabs.map((path) => {
                const name = getFileName(path);
                const isActive = selectedFile === path;
                const isDirty = filesData[path] ? filesData[path].savedContent !== filesData[path].currentContent : false;
                return (
                  <div
                    key={path}
                    className={`tab-item ${isActive ? "active" : ""} ${draggedTab === path ? "dragging" : ""}`}
                    onClick={() => handleSelectFile(path)}
                    title={path}
                    draggable
                    onDragStart={(e) => handleDragStart(e, path)}
                    onDragOver={(e) => handleDragOver(e, path)}
                    onDragEnd={handleDragEnd}
                  >
                    <span className="tab-title">{name}</span>
                    {isDirty && <span className="tab-dirty-dot" />}
                    <button
                      className="tab-close-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseTab(path);
                      }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            {Object.values(filesData).some(d => d.savedContent !== d.currentContent) && (
              <button
                className="save-all-btn"
                onClick={handleSaveAll}
                title="Save All (Cmd+Alt+S)"
              >
                Save All
              </button>
            )}
            {selectedFile && (
              <div className="tab-copy-actions">
                {copyFeedback && <span className="copy-feedback">{copyFeedback}</span>}
                <button
                  className="tab-copy-btn"
                  onClick={() => copyToClipboard(getFileName(selectedFile), "name")}
                  title="Copy file name"
                >
                  <Type className="w-3.5 h-3.5" />
                </button>
                <button
                  className="tab-copy-btn"
                  onClick={() => copyToClipboard(selectedFile, "path")}
                  title="Copy file path (Cmd+Shift+C)"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Content Area */}
        <div style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minHeight: 0, display: "flex", overflow: "hidden" }}>
          {isLoadingFile ? (
            <div className="no-file-selected">
              <Loader2 className="w-10 h-10 animate-spin text-accent" style={{ marginBottom: "16px" }} />
              <p>Loading file content...</p>
            </div>
          ) : selectedFile ? (
            fileError ? (
              <div className="no-file-selected">
                <AlertCircle className="w-12 h-12" style={{ marginBottom: "16px", color: "hsl(0, 84%, 60%)" }} />
                <h2 style={{ margin: "0 0 8px 0", fontWeight: 600, fontSize: "18px" }}>Cannot Read File</h2>
                <p style={{ margin: 0, fontSize: "14px", opacity: 0.8, maxWidth: "360px", color: "var(--text-secondary)" }}>
                  {fileError.includes("invalid utf-8") 
                    ? "This file appears to be a binary file and cannot be read as text." 
                    : `Failed to load file content: ${fileError}`}
                </p>
              </div>
            ) : isMediaFile(selectedFile) ? (
              <MediaViewer filePath={selectedFile} />
            ) : (
              <MarkdownEditor
                key={selectedFile}
                filePath={selectedFile}
                pathLabel={displayRelativePath(selectedFile, pinnedWorkspaces)}
                initialContent={filesData[selectedFile]?.currentContent || ""}
                onSave={handleSaveFile}
                onChange={handleContentChange}
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

        {/* Resizer and Terminal Pane (desktop only; always mounted to preserve session state) */}
        {storage.capabilities.terminal && (
          <>
            <div
              className="terminal-resizer"
              onMouseDown={startTerminalResize}
              style={{ display: isTerminalOpen ? "block" : "none" }}
            />
            <div
              style={{
                height: isTerminalOpen ? `${terminalHeight}px` : "0px",
                display: isTerminalOpen ? "flex" : "none",
                flexDirection: "column",
                flexShrink: 0
              }}
            >
              <TerminalPane
                currentPath={currentPath}
                onClose={() => setIsTerminalOpen(false)}
              />
            </div>
          </>
        )}
      </div>

      {/* Custom Confirm Modal Dialog */}
      {confirmDialog && confirmDialog.isOpen && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal">
            <h3>{confirmDialog.title}</h3>
            <p>{confirmDialog.message}</p>
            <div className="confirm-modal-actions">
              <button 
                className="confirm-btn-primary" 
                onClick={async () => {
                  await confirmDialog.onConfirm();
                  setConfirmDialog(null);
                }}
              >
                Save
              </button>
              {confirmDialog.onDiscard && (
                <button 
                  className="confirm-btn-secondary" 
                  onClick={async () => {
                    await confirmDialog.onDiscard?.();
                    setConfirmDialog(null);
                  }}
                >
                  Don't Save
                </button>
              )}
              {confirmDialog.onCancel && (
                <button 
                  className="confirm-btn-cancel" 
                  onClick={() => {
                    confirmDialog.onCancel?.();
                    setConfirmDialog(null);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
