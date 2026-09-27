import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FileBrowser from "./components/FileBrowser";
import MarkdownEditor from "./components/MarkdownEditor";
import MediaViewer from "./components/MediaViewer";
import TerminalPane from "./components/TerminalPane";
import { storage, type PathStat } from "./storage";
import { useDiskChanges, recordPathSignature } from "./hooks/useDiskChanges";
import { displayRelativePath } from "./utils/paths";
import { computeLineDiff, diffStats } from "./utils/diff";
import { FileCode, Loader2, X, AlertCircle, RefreshCw, Copy, FileText, ChevronLeft, Diff, CheckCircle, AlertTriangle } from "lucide-react";

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
  // Transient "just saved" flash shown in the tabs bar (a slot that already
  // appears/disappears based on dirty state, so this reuses layout space
  // instead of shifting anything, unlike the old inline "Saved" label that
  // used to live in the editor's save-status row).
  const [justSaved, setJustSaved] = useState(false);
  // One-shot signal: the file the "Quick Note" widget most recently jumped
  // to, so MarkdownEditor can move the cursor to the end and focus it once
  // the file finishes loading. MarkdownEditor clears it back to null (via
  // onFocusAtEndHandled) right after consuming it, so reopening the same
  // file later through normal navigation doesn't re-trigger the jump.
  const [quickNoteFocusPath, setQuickNoteFocusPath] = useState<string | null>(null);
  // On-disk change tracking for the open files. `diskSignaturesRef` holds the
  // signature (mtime+size) each file had the last time the app itself read or
  // wrote it, so the poll below can tell someone else's write apart from our
  // own. `externalChanges` marks the files whose disk content the app could
  // *not* silently adopt because the buffer has unsaved edits (or the file
  // vanished) — those get a warning banner and a tab marker instead.
  const diskSignaturesRef = useRef<Record<string, string>>({});
  const [externalChanges, setExternalChanges] = useState<
    Record<string, { kind: "changed" | "deleted"; diskContent?: string }>
  >({});
  // Bumped per file to force a fresh MarkdownEditor mount when content is
  // replaced from disk underneath it (the editor seeds itself from
  // `initialContent` once, so remounting is what makes a reload visible).
  const [editorReloadKeys, setEditorReloadKeys] = useState<Record<string, number>>({});

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
    // When present, the dialog can reveal a saved-vs-current line diff.
    diff?: { savedContent: string; currentContent: string };
  } | null>(null);

  // Whether the diff panel inside the confirm dialog is expanded.
  const [showDiff, setShowDiff] = useState(false);

  // Compute the diff only while the panel is open, and memoize on the content.
  const diffLines = useMemo(() => {
    if (!showDiff || !confirmDialog?.diff) return null;
    return computeLineDiff(confirmDialog.diff.savedContent, confirmDialog.diff.currentContent);
  }, [showDiff, confirmDialog]);

  // Standalone "view changes" modal for the currently open file (separate from
  // the close/quit confirmation dialog's diff panel above).
  const [diffViewOpen, setDiffViewOpen] = useState(false);
  // "View differences" from the outside-change banner: the version on disk
  // against the (edited) one open here.
  const [externalDiffOpen, setExternalDiffOpen] = useState(false);
  const currentFileData = selectedFile ? filesData[selectedFile] : undefined;
  const currentFileIsDirty = !!currentFileData && currentFileData.savedContent !== currentFileData.currentContent;
  const diffViewLines = useMemo(() => {
    if (!diffViewOpen || !currentFileData) return null;
    return computeLineDiff(currentFileData.savedContent, currentFileData.currentContent);
  }, [diffViewOpen, currentFileData]);

  const externalDiskContent = selectedFile ? externalChanges[selectedFile]?.diskContent : undefined;
  const externalDiffLines = useMemo(() => {
    if (!externalDiffOpen || externalDiskContent === undefined || !currentFileData) return null;
    return computeLineDiff(externalDiskContent, currentFileData.currentContent);
  }, [externalDiffOpen, externalDiskContent, currentFileData]);

  // Close the comparison as soon as there is nothing left to compare (the
  // banner was dismissed, the file was reloaded or saved, or a different tab
  // became active).
  useEffect(() => {
    if (externalDiskContent === undefined) setExternalDiffOpen(false);
  }, [externalDiskContent]);

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
        setShowDiff(false);
        setConfirmDialog({
          isOpen: true,
          title: "Unsaved Changes",
          message: dirtyFiles.length === 1
            ? `"${getFileName(dirtyFiles[0][0])}" has unsaved changes. Do you want to save them before quitting?`
            : `You have unsaved changes in ${dirtyFiles.length} files. Do you want to save them before quitting?`,
          diff: dirtyFiles.length === 1
            ? { savedContent: dirtyFiles[0][1].savedContent, currentContent: dirtyFiles[0][1].currentContent }
            : undefined,
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

  // Pinned shortcuts are shared with the CLI/TUI via the mdcmd config file
  // (stored there, and in the storage/Tauri API, as "workspaces" for
  // backward compatibility — only the UI-facing name changed).
  const [pinnedShortcuts, setPinnedShortcuts] = useState<PinnedItem[]>([]);
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false);

  // Load shortcuts from the shared config on mount, migrating any legacy
  // localStorage shortcuts into the shared config on first run.
  //
  // On iOS the pinned shortcuts are folders reached through the native document
  // picker; their access is granted via security-scoped bookmarks that must be
  // re-activated on each launch. Do that first so listing a restored folder
  // works, then load the shortcuts.
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
                setPinnedShortcuts(migrated);
                localStorage.removeItem("tauri-markdown-workspaces");
                return;
              }
            }
          } catch {
            // ignore malformed legacy data
          }
        }
        setPinnedShortcuts(items);
      })
      .catch((err) => console.error("Failed to load shortcuts:", err))
      .finally(() => setShortcutsLoaded(true));
      });
  }, []);

  // Persist shortcuts back to the shared config whenever they change.
  useEffect(() => {
    if (!shortcutsLoaded) return;
    storage.writeWorkspaces(pinnedShortcuts).catch((err) =>
      console.error("Failed to save shortcuts:", err)
    );
  }, [pinnedShortcuts, shortcutsLoaded]);

  const sortedPinned = useMemo(() => {
    return [...pinnedShortcuts].sort((a, b) => {
      if (a.isDir && !b.isDir) return 1;
      if (!a.isDir && b.isDir) return -1;
      return a.path.localeCompare(b.path);
    });
  }, [pinnedShortcuts]);

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

  // Sidebar's max resizable width. The web/Dropbox build defaults to (and can
  // be resized up to) half the window, since 450px reads as a tiny sliver on
  // a full browser window — the desktop build keeps the narrower cap since
  // its window is usually sized to the app already.
  const maxSidebarWidth = isDesktop ? 450 : Math.max(450, Math.round(window.innerWidth * 0.6));

  // Persistent sidebar width state
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("tauri-markdown-sidebar-width");
      if (saved) return parseInt(saved, 10);
    } catch {
      // fall through to the default below
    }
    return isDesktop ? 260 : Math.max(260, Math.round(window.innerWidth / 2));
  });

  useEffect(() => {
    localStorage.setItem("tauri-markdown-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  // Handle drag resizing for the sidebar
  const startSidebarResize = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(180, Math.min(maxSidebarWidth, moveEvent.clientX));
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

  // Remember what `path` looks like on disk right now, so the poll below can
  // recognise the app's own read/write instead of reporting it as someone
  // else's change. Best-effort: on a backend without `statPaths` nothing is
  // recorded and nothing is polled.
  const recordDiskSignature = (path: string) => recordPathSignature(diskSignaturesRef, path);

  const clearExternalChange = (path: string) => {
    setExternalChanges((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  };

  // Replace a file's buffer with what's on disk and remount its editor.
  const applyDiskContent = (path: string, content: string) => {
    setFilesData((prev) => ({
      ...prev,
      [path]: { savedContent: content, currentContent: content },
    }));
    setEditorReloadKeys((prev) => ({ ...prev, [path]: (prev[path] ?? 0) + 1 }));
    clearExternalChange(path);
  };

  // Discard the local edits and take the disk version (the banner's "Reload").
  const reloadFromDisk = async (path: string) => {
    try {
      const content = await storage.readFile(path);
      await recordDiskSignature(path);
      applyDiskContent(path, content);
    } catch (err) {
      alert(`Error reloading file: ${err}`);
    }
  };

  // Only text files have a buffer to keep in sync; media is left alone (the
  // webview caches it by URL, so there is nothing useful to refresh).
  const watchedFiles = useMemo(
    () => openTabs.filter((path) => !isMediaFile(path)),
    [openTabs],
  );

  // React to one of the open files changing on disk. A clean buffer just
  // follows the file; a dirty one is never overwritten — it gets the warning
  // banner so the user picks (see `externalChanges`).
  const handleDiskChange = async (path: string, stat: PathStat | null) => {
    if (!stat) {
      setExternalChanges((prev) =>
        prev[path]?.kind === "deleted" ? prev : { ...prev, [path]: { kind: "deleted" } },
      );
      return;
    }
    if (!filesDataRef.current[path]) return; // never loaded (or already closed)

    let diskContent: string;
    try {
      diskContent = await storage.readFile(path);
    } catch {
      return; // mid-write or briefly unreadable — the next poll picks it up
    }
    const data = filesDataRef.current[path];
    if (!data) return;

    if (diskContent === data.currentContent) {
      // Same text we already show (e.g. someone saved our own edits for us):
      // nothing to warn about, and the buffer is no longer dirty.
      setFilesData((prev) =>
        prev[path] && prev[path].savedContent !== diskContent
          ? { ...prev, [path]: { savedContent: diskContent, currentContent: diskContent } }
          : prev,
      );
      clearExternalChange(path);
      return;
    }

    if (data.savedContent === data.currentContent) {
      applyDiskContent(path, diskContent);
      return;
    }

    setExternalChanges((prev) => ({ ...prev, [path]: { kind: "changed", diskContent } }));
  };

  useDiskChanges(watchedFiles, diskSignaturesRef, handleDiskChange);

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
      await recordDiskSignature(filePath);
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

  // Open files handed to the app by the OS: iOS "Open With" / share menu, or a
  // file opened with the desktop app. The Rust side buffers cold-launch opens
  // (drained here on mount) and emits `files-opened` while running.
  const handleSelectFileRef = useRef(handleSelectFile);
  handleSelectFileRef.current = handleSelectFile;
  useEffect(() => {
    if (storage.id !== "tauri") return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const openFirst = (paths?: string[] | null) => {
      const p = paths?.find(Boolean);
      if (p) handleSelectFileRef.current(p);
    };
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string[]>("files-opened", (e) => openFirst(e.payload)),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    invoke<string[]>("drain_opened_files").then(openFirst).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Jump into the configured Quick Note target when the iOS Home Screen
  // widget is tapped (delivered the same way as opened files: buffered for a
  // cold-launch drain, and emitted live while the app is already running).
  const openQuickNoteRef = useRef<() => void>(() => {});
  openQuickNoteRef.current = () => {
    storage.readQuickNoteTarget?.()
      .then((target) => {
        if (!target) return;
        handleSelectFileRef.current(target);
        setQuickNoteFocusPath(target);
      })
      .catch(() => {});
  };
  useEffect(() => {
    if (storage.id !== "tauri") return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("quick-note-requested", () => openQuickNoteRef.current()),
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    invoke<number>("drain_quick_note_request")
      .then((count) => {
        if (count > 0) openQuickNoteRef.current();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
      delete diskSignaturesRef.current[pathToRemove];
      clearExternalChange(pathToRemove);

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
      setShowDiff(false);
      setConfirmDialog({
        isOpen: true,
        title: "Unsaved Changes",
        message: `"${getFileName(pathToRemove)}" has unsaved changes. Do you want to save them before closing?`,
        diff: {
          savedContent: filesData[pathToRemove].savedContent,
          currentContent: filesData[pathToRemove].currentContent,
        },
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

  const getParentFolderName = (path: string) => {
    const isWindows = path.includes("\\");
    const separator = isWindows ? "\\" : "/";
    const trimmed = path.slice(0, path.lastIndexOf(separator));
    return getFileName(trimmed);
  };

  // Tab labels: bare file name, except when two or more open tabs share the
  // same name, in which case those tabs are prefixed with their parent
  // folder name so e.g. two "TODO.md" tabs read as "chemistry/TODO.md" and
  // "physics/TODO.md" instead of being indistinguishable.
  const tabLabels = useMemo(() => {
    const nameCounts: Record<string, number> = {};
    openTabs.forEach((path) => {
      const name = getFileName(path);
      nameCounts[name] = (nameCounts[name] || 0) + 1;
    });
    const labels: Record<string, string> = {};
    openTabs.forEach((path) => {
      const name = getFileName(path);
      labels[path] = nameCounts[name] > 1 ? `${getParentFolderName(path)}/${name}` : name;
    });
    return labels;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTabs]);

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

  // Flash the "Saved" indicator in the tabs bar for a couple seconds.
  const flashSaved = () => {
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  };

  // Write content back to the local file
  const handleSaveFile = async (filePath: string, content: string) => {
    try {
      await storage.writeFile(filePath, content);
      await recordDiskSignature(filePath);
      setFilesData(prev => ({
        ...prev,
        [filePath]: { savedContent: content, currentContent: content }
      }));
      // Our own write is now the version on disk, so any outside-change
      // warning for this file is resolved.
      clearExternalChange(filePath);
      flashSaved();
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
          await recordDiskSignature(path);
          clearExternalChange(path);
        })
      );
      setFilesData(prev => {
        const next = { ...prev };
        dirtyFiles.forEach(([path, data]) => {
          next[path] = { savedContent: data.currentContent, currentContent: data.currentContent };
        });
        return next;
      });
      flashSaved();
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

  // Disable the webview's native zoom, which is far too easy to trigger by
  // accident: Cmd/Ctrl + scroll and trackpad pinch (which WebKit reports as
  // ctrl-key wheel events and `gesture*` events). The app has its own editor
  // zoom controls, so nothing here is lost.
  useEffect(() => {
    const preventZoomWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const preventGesture = (e: Event) => e.preventDefault();

    window.addEventListener("wheel", preventZoomWheel, { passive: false });
    window.addEventListener("gesturestart", preventGesture);
    window.addEventListener("gesturechange", preventGesture);
    window.addEventListener("gestureend", preventGesture);
    return () => {
      window.removeEventListener("wheel", preventZoomWheel);
      window.removeEventListener("gesturestart", preventGesture);
      window.removeEventListener("gesturechange", preventGesture);
      window.removeEventListener("gestureend", preventGesture);
    };
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

  // Keybindings Cmd-1..9 (tabs) and Cmd-Shift-1..9 (pinned shortcuts)
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

  // Keyboard shortcut Cmd+N / Ctrl+N to open a new app window (desktop only)
  useEffect(() => {
    if (!isDesktop) return;
    const handleNewWindow = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        invoke("open_new_window").catch((err) => console.error("Failed to open new window:", err));
      }
    };
    window.addEventListener("keydown", handleNewWindow);
    return () => window.removeEventListener("keydown", handleNewWindow);
  }, []);

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
        pinnedShortcuts={pinnedShortcuts}
        setPinnedShortcuts={setPinnedShortcuts}
        sortedPinned={sortedPinned}
        viewMode={viewMode}
        setViewMode={setViewMode}
        onUpdateFound={(version) => {
          setUpdateVersion(version);
          setUpdateDismissed(false);
        }}
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
                const name = tabLabels[path] ?? getFileName(path);
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
                    {externalChanges[path] && (
                      <span
                        className="tab-external-icon"
                        title={
                          externalChanges[path].kind === "deleted"
                            ? "This file no longer exists on disk"
                            : "This file changed on disk"
                        }
                      >
                        <AlertTriangle className="w-3 h-3" />
                      </span>
                    )}
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
            {Object.values(filesData).some(d => d.savedContent !== d.currentContent) ? (
              <button
                className="save-all-btn"
                onClick={handleSaveAll}
                title="Save All (Cmd+Alt+S)"
              >
                Save All
              </button>
            ) : justSaved ? (
              <span style={{ color: "hsl(142, 71%, 45%)", display: "flex", alignItems: "center", gap: "4px", fontSize: "13px", padding: "0 8px" }}>
                <CheckCircle className="w-4 h-4" /> Saved
              </span>
            ) : null}
            {selectedFile && (
              <div className="tab-copy-actions">
                {copyFeedback && <span className="copy-feedback">{copyFeedback}</span>}
                <button
                  className="tab-copy-btn"
                  onClick={() => copyToClipboard(getFileName(selectedFile), "name")}
                  title="Copy file name"
                >
                  <FileText className="w-3.5 h-3.5" />
                </button>
                <button
                  className="tab-copy-btn"
                  onClick={() => copyToClipboard(selectedFile, "path")}
                  title="Copy file path (Cmd+Shift+C)"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                {currentFileIsDirty && (
                  <button
                    className="tab-copy-btn"
                    onClick={() => setDiffViewOpen(true)}
                    title="View changes since last save"
                  >
                    <Diff className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Outside-change warning for the active file. Only reached when the
            buffer has unsaved edits (or the file is gone) — an unedited file is
            reloaded silently instead, with no banner. */}
        {selectedFile && externalChanges[selectedFile] && (
          <div className="external-change-banner">
            <AlertTriangle className="w-4 h-4" style={{ flexShrink: 0 }} />
            <span>
              {externalChanges[selectedFile].kind === "deleted"
                ? "This file no longer exists on disk. The version open here is untouched."
                : "This file changed on disk while you were editing it."}
            </span>
            {externalChanges[selectedFile].kind === "deleted" ? (
              <button
                className="external-change-btn"
                onClick={() => {
                  const data = filesData[selectedFile];
                  if (data) handleSaveFile(selectedFile, data.currentContent);
                }}
              >
                Save to disk
              </button>
            ) : (
              <>
                <button
                  className="external-change-btn"
                  onClick={() => setExternalDiffOpen(true)}
                  title="Compare the version on disk with the one open here"
                >
                  View differences
                </button>
                <button
                  className="external-change-btn"
                  onClick={() => reloadFromDisk(selectedFile)}
                  title="Discard your edits and load the version on disk"
                >
                  Reload from disk
                </button>
              </>
            )}
            <button
              className="external-change-dismiss-btn"
              title="Keep my version"
              onClick={() => clearExternalChange(selectedFile)}
            >
              <X className="w-3 h-3" />
            </button>
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
                key={`${selectedFile}#${editorReloadKeys[selectedFile] ?? 0}`}
                filePath={selectedFile}
                pathLabel={displayRelativePath(selectedFile, pinnedShortcuts)}
                initialContent={filesData[selectedFile]?.currentContent || ""}
                isDirty={filesData[selectedFile]?.savedContent !== filesData[selectedFile]?.currentContent}
                onSave={handleSaveFile}
                onChange={handleContentChange}
                onOpenFile={handleSelectFile}
                focusAtEndFor={quickNoteFocusPath}
                onFocusAtEndHandled={() => setQuickNoteFocusPath(null)}
                isPinned={pinnedShortcuts.some((p) => p.path === selectedFile)}
                onTogglePin={() => {
                  setPinnedShortcuts(
                    pinnedShortcuts.some((p) => p.path === selectedFile)
                      ? pinnedShortcuts.filter((p) => p.path !== selectedFile)
                      : [...pinnedShortcuts, { path: selectedFile, isDir: false }]
                  );
                }}
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
          <div className={`confirm-modal${showDiff && confirmDialog.diff ? " with-diff" : ""}`}>
            <h3>{confirmDialog.title}</h3>
            <p>{confirmDialog.message}</p>
            {confirmDialog.diff && (
              <div className="confirm-diff-section">
                <button
                  className="confirm-diff-toggle"
                  onClick={() => setShowDiff((v) => !v)}
                >
                  {showDiff ? "Hide changes" : "View changes"}
                  {(() => {
                    if (showDiff || !confirmDialog.diff) return null;
                    const stats = diffStats(
                      computeLineDiff(confirmDialog.diff.savedContent, confirmDialog.diff.currentContent)
                    );
                    return (
                      <span className="confirm-diff-stats">
                        <span className="diff-added">+{stats.added}</span>
                        <span className="diff-removed">−{stats.removed}</span>
                      </span>
                    );
                  })()}
                </button>
                {showDiff && diffLines && (
                  <div className="confirm-diff-view">
                    {diffLines.length === 0 ? (
                      <div className="diff-empty">No line changes</div>
                    ) : (
                      diffLines.map((line, idx) => (
                        <div key={idx} className={`diff-line diff-${line.type}`}>
                          <span className="diff-gutter">
                            {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                          </span>
                          <span className="diff-text">{line.text || " "}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
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

      {/* Disk-vs-buffer comparison opened from the outside-change banner */}
      {externalDiffOpen && externalDiskContent !== undefined && (
        <div className="confirm-modal-overlay" onClick={() => setExternalDiffOpen(false)}>
          <div className="confirm-modal with-diff" onClick={(e) => e.stopPropagation()}>
            <h3>Version on disk vs. yours</h3>
            <p>Lines marked + are only in your open version, − only in the file on disk.</p>
            <div className="confirm-diff-section">
              <div className="confirm-diff-view">
                {externalDiffLines && externalDiffLines.length === 0 ? (
                  <div className="diff-empty">No line changes</div>
                ) : (
                  externalDiffLines?.map((line, idx) => (
                    <div key={idx} className={`diff-line diff-${line.type}`}>
                      <span className="diff-gutter">
                        {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                      </span>
                      <span className="diff-text">{line.text || " "}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="confirm-modal-actions">
              <button
                className="confirm-btn-secondary"
                onClick={() => {
                  setExternalDiffOpen(false);
                  if (selectedFile) reloadFromDisk(selectedFile);
                }}
              >
                Reload from disk
              </button>
              <button
                className="confirm-btn-primary"
                onClick={() => {
                  // Deciding to keep the local version also settles the
                  // warning, so the banner and tab marker go with the modal.
                  setExternalDiffOpen(false);
                  if (selectedFile) clearExternalChange(selectedFile);
                }}
              >
                Keep mine
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Standalone "view changes" modal for the current file */}
      {diffViewOpen && currentFileData && (
        <div className="confirm-modal-overlay" onClick={() => setDiffViewOpen(false)}>
          <div className="confirm-modal with-diff" onClick={(e) => e.stopPropagation()}>
            <h3>Changes since last save</h3>
            <div className="confirm-diff-section">
              <div className="confirm-diff-view">
                {diffViewLines && diffViewLines.length === 0 ? (
                  <div className="diff-empty">No line changes</div>
                ) : (
                  diffViewLines?.map((line, idx) => (
                    <div key={idx} className={`diff-line diff-${line.type}`}>
                      <span className="diff-gutter">
                        {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                      </span>
                      <span className="diff-text">{line.text || " "}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="confirm-modal-actions">
              <button className="confirm-btn-primary" onClick={() => setDiffViewOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
