import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { storage } from "../storage";
import {
  Folder,
  FileText,
  ChevronLeft,
  Loader2,
  AlertCircle,
  Pin,
  X,
  Image as ImageIcon,
  Video as VideoIcon,
  Terminal as TerminalIcon,
  FolderTree,
  List,
  FilePlus,
  FolderPlus,
} from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface PinnedItem {
  path: string;
  isDir: boolean;
}

interface VersionInfo {
  version: string;
  commit: string;
  commitDate: string;
}

interface FileBrowserProps {
  currentPath: string;
  setCurrentPath: (path: string) => void;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  width: number;
  pinnedWorkspaces: PinnedItem[];
  setPinnedWorkspaces: (items: PinnedItem[]) => void;
  sortedPinned: PinnedItem[];
  viewMode: "list" | "tree";
  setViewMode: (mode: "list" | "tree") => void;
}

export default function FileBrowser({
  currentPath,
  setCurrentPath,
  selectedFile,
  onSelectFile,
  width,
  pinnedWorkspaces,
  setPinnedWorkspaces,
  sortedPinned,
  viewMode,
  setViewMode,
}: FileBrowserProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [sortOrder, setSortOrder] = useState<"name" | "mtime">("name");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Detailed build/version info shown in the sidebar footer. Only the native
  // (Tauri) build exposes the `app_version_info` command; the web build leaves
  // this null and the footer is hidden.
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);

  // New-file creation state
  const [creatingFile, setCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const newFileInputRef = useRef<HTMLInputElement>(null);

  const sidebarRef = useRef<HTMLDivElement>(null);

  // Active section tracking: "workspace" or "folders"
  const [activeSection, setActiveSection] = useState<"workspace" | "folders">("folders");
  const [focusedWorkspaceIndex, setFocusedWorkspaceIndex] = useState<number>(0);
  const [focusedEntryIndex, setFocusedEntryIndex] = useState<number>(0);

  // Persistent workspace pane height percentage (default 25%)
  const [workspaceHeightPercent, setWorkspaceHeightPercent] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("tauri-markdown-workspace-ratio");
      return saved ? parseFloat(saved) : 25;
    } catch {
      return 25;
    }
  });

  useEffect(() => {
    localStorage.setItem("tauri-markdown-workspace-ratio", String(workspaceHeightPercent));
  }, [workspaceHeightPercent]);

  // Fetch build/version info once (native builds only).
  useEffect(() => {
    if (storage.id !== "tauri") return;
    invoke<VersionInfo>("app_version_info")
      .then(setVersionInfo)
      .catch(() => {});
  }, []);

  // Focus sidebar on mount
  useEffect(() => {
    sidebarRef.current?.focus();
  }, []);

  // Drag resizing for workspace section height
  const startSectionResize = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    const sidebarElement = mouseDownEvent.currentTarget.parentElement;
    if (!sidebarElement) return;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const rect = sidebarElement.getBoundingClientRect();
      const relativeY = moveEvent.clientY - rect.top;
      const percent = Math.max(15, Math.min(80, (relativeY / rect.height) * 100));
      setWorkspaceHeightPercent(percent);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [treeEntries, setTreeEntries] = useState<Record<string, FileEntry[]>>({});
  const [focusedNodeIndex, setFocusedNodeIndex] = useState<number>(0);
  const [treeRootPath, setTreeRootPath] = useState<string>(currentPath || "/");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchScope, setSearchScope] = useState<"folder" | "workspaces">("folder");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const getFileName = (pathStr: string) => {
    const isWindows = pathStr.includes("\\");
    const separator = isWindows ? "\\" : "/";
    return pathStr.substring(pathStr.lastIndexOf(separator) + 1) || pathStr;
  };

  // Global key bindings to focus search input
  // '/' toggles folder search, 'Cmd+Shift+F' or 'Ctrl+Shift+F' toggles workspace search
  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      const isCmd = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;
      
      // Ignore if typing inside input or editor
      if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName || "")) {
        return;
      }
      if (document.activeElement?.closest(".ProseMirror")) {
        return;
      }

      if (isCmd && isShift && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchScope("workspaces");
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === "/") {
        e.preventDefault();
        setSearchScope("folder");
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleGlobalShortcuts);
    return () => window.removeEventListener("keydown", handleGlobalShortcuts);
  }, []);

  // Directory recursive search invoke
  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([]);
      return;
    }
    const delayDebounceFn = setTimeout(async () => {
      setIsSearching(true);
      try {
        if (searchScope === "workspaces") {
          // Search in all pinned workspaces
          const allResults: FileEntry[] = [];
          const seenPaths = new Set<string>();

          for (const item of pinnedWorkspaces) {
            if (item.isDir) {
              try {
                const res = await storage.searchDirectory(item.path, searchQuery);
                for (const entry of res) {
                  if (!seenPaths.has(entry.path)) {
                    seenPaths.add(entry.path);
                    allResults.push(entry);
                  }
                }
              } catch (err) {
                console.error(`Search error in workspace ${item.path}:`, err);
              }
            } else {
              // Pinned file: match name case-insensitively
              const fileName = getFileName(item.path);
              if (fileName.toLowerCase().includes(searchQuery.toLowerCase())) {
                if (!seenPaths.has(item.path)) {
                  seenPaths.add(item.path);
                  allResults.push({
                    path: item.path,
                    name: fileName,
                    is_dir: false
                  });
                }
              }
            }
          }
          setSearchResults(allResults);
        } else {
          // Search in current folder
          const root = viewMode === "tree" ? treeRootPath : currentPath;
          const res = await storage.searchDirectory(root, searchQuery);
          setSearchResults(res);
        }
      } catch (err) {
        console.error("Search error:", err);
      } finally {
        setIsSearching(false);
      }
    }, 150);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery, searchScope, viewMode, treeRootPath, currentPath, pinnedWorkspaces]);

  // Sync treeRootPath when currentPath is set and treeRootPath is still "/"
  useEffect(() => {
    if (currentPath && treeRootPath === "/") {
      setTreeRootPath(currentPath);
    }
  }, [currentPath]);

  // Load subdirectory entries for Tree View
  const loadTreeDirectory = async (path: string) => {
    if (treeEntries[path]) return; // already loaded
    try {
      const res = await storage.listDirectory(path);
      setTreeEntries((prev) => ({
        ...prev,
        [path]: res,
      }));
    } catch (err) {
      console.error(`Error loading tree directory ${path}:`, err);
    }
  };

  // Sync root directory loading when treeRootPath changes
  useEffect(() => {
    if (treeRootPath) {
      loadTreeDirectory(treeRootPath);
    }
  }, [treeRootPath]);

  // Toggle expansion of a folder path
  const toggleExpand = async (path: string) => {
    const isExpanding = !expandedPaths[path];
    setExpandedPaths((prev) => ({
      ...prev,
      [path]: isExpanding,
    }));
    if (isExpanding) {
      await loadTreeDirectory(path);
    }
  };

  interface FlatTreeNode {
    path: string;
    name: string;
    isDir: boolean;
    depth: number;
    parentPath: string | null;
  }

  const getFlatTreeNodes = (): FlatTreeNode[] => {
    const nodes: FlatTreeNode[] = [];
    const traverse = (path: string, depth: number) => {
      const entries = treeEntries[path] || [];
      for (const entry of entries) {
        nodes.push({
          path: entry.path,
          name: entry.name,
          isDir: entry.is_dir,
          depth,
          parentPath: path,
        });
        if (entry.is_dir && expandedPaths[entry.path]) {
          traverse(entry.path, depth + 1);
        }
      }
    };
    traverse(treeRootPath, 0);
    return nodes;
  };

  const flatNodes = getFlatTreeNodes();

  // Sync folders focus bounds when entries change
  useEffect(() => {
    if (viewMode === "tree") {
      if (flatNodes.length === 0) {
        setFocusedNodeIndex(-1);
        if (activeSection === "folders" && sortedPinned.length > 0) {
          setActiveSection("workspace");
          setFocusedWorkspaceIndex(sortedPinned.length - 1);
        }
      } else {
        if (focusedNodeIndex < 0 || focusedNodeIndex >= flatNodes.length) {
          setFocusedNodeIndex(0);
        }
      }
    } else {
      if (entries.length === 0) {
        setFocusedEntryIndex(-1);
        if (activeSection === "folders" && sortedPinned.length > 0) {
          setActiveSection("workspace");
          setFocusedWorkspaceIndex(sortedPinned.length - 1);
        }
      } else {
        if (focusedEntryIndex < 0 || focusedEntryIndex >= entries.length) {
          setFocusedEntryIndex(0);
        }
      }
    }
  }, [entries, activeSection, sortedPinned.length, flatNodes.length, viewMode]);

  // Sync workspaces focus bounds when pinned items change
  useEffect(() => {
    if (sortedPinned.length === 0) {
      setFocusedWorkspaceIndex(-1);
      if (activeSection === "workspace") {
        setActiveSection("folders");
        if (viewMode === "tree") {
          setFocusedNodeIndex(0);
        } else {
          setFocusedEntryIndex(0);
        }
      }
    } else {
      if (focusedWorkspaceIndex < 0 || focusedWorkspaceIndex >= sortedPinned.length) {
        setFocusedWorkspaceIndex(0);
      }
    }
  }, [sortedPinned, activeSection, viewMode]);

  // Sync folders focus index with selectedFile when entries or selectedFile changes
  useEffect(() => {
    if (selectedFile && entries.length > 0) {
      const index = entries.findIndex((entry) => entry.path === selectedFile);
      if (index !== -1) {
        setFocusedEntryIndex(index);
        setActiveSection("folders");
      }
    }
  }, [selectedFile, entries]);

  // Sync folders focus index with selectedFile in tree mode
  useEffect(() => {
    if (viewMode === "tree" && selectedFile && flatNodes.length > 0) {
      const index = flatNodes.findIndex((node) => node.path === selectedFile);
      if (index !== -1) {
        setFocusedNodeIndex(index);
        setActiveSection("folders");
      }
    }
  }, [selectedFile, flatNodes.length, viewMode]);

  // Scroll focused entry or workspace folder into view
  useEffect(() => {
    const el = sidebarRef.current?.querySelector(".keyboard-focused");
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusedEntryIndex, focusedWorkspaceIndex, activeSection]);

  // Initialize path to home directory if empty
  useEffect(() => {
    if (!currentPath) {
      setLoading(true);
      storage.getHomeDir()
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

  storage.listDirectory(currentPath)
    .then((data) => {
      if (active) {
        const sorted = [...data].sort((a, b) => {
          if (sortOrder === "mtime") {
             // Note: Backend doesn't currently provide mtime. Placeholder logic.
             return 0;
          }
          return a.name.localeCompare(b.name);
        });
        setEntries(sorted);
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
  }, [currentPath, reloadToken, sortOrder]);

  // Go to parent directory
  // The pinned "storage root" that contains `path` (the longest matching pinned
  // directory), with any trailing separator stripped — or null. On mobile these
  // are folders picked via the document picker, and browsing must not go above
  // them (that would leave the security-scoped sandbox).
  const getPinnedRoot = (path: string): string | null => {
    if (!path) return null;
    const sep = path.includes("\\") ? "\\" : "/";
    const root = pinnedWorkspaces
      .filter(
        (p) =>
          p.isDir &&
          (path === p.path ||
            path.startsWith(p.path.replace(/[/\\]+$/, "") + sep)),
      )
      .sort((a, b) => b.path.length - a.path.length)[0];
    return root ? root.path.replace(/[/\\]+$/, "") : null;
  };

  // Whether navigation is capped at a picked root (mobile document-picker roots
  // are security-scoped, so going above them isn't allowed).
  const navRoot = () =>
    storage.capabilities.documentPicker ? getPinnedRoot(currentPath) : null;

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

      // Don't step above a picked storage root.
      const root = navRoot();
      if (root && (parent.length < root.length || !root.startsWith(parent))) {
        return;
      }

      setCurrentPath(parent || separator);
    }
  };

  // Determine if we can go up further
  const canGoUp = () => {
    if (!currentPath) return false;
    // At (or would step above) a picked storage root: stop here.
    const root = navRoot();
    if (root && currentPath.replace(/[/\\]+$/, "") === root) {
      return false;
    }
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

  // Show a path relative to its pinned "storage root" (e.g. a folder picked
  // from Files / iCloud Drive), like "Notes › drafts › todo.md", instead of the
  // raw device path (/private/var/mobile/…). Falls back to the absolute path
  // when it isn't under any pinned root.
  const displayPath = (fullPath: string) => {
    if (!fullPath) return fullPath;
    const sep = fullPath.includes("\\") ? "\\" : "/";
    const root = pinnedWorkspaces
      .filter(
        (p) =>
          p.isDir &&
          (fullPath === p.path ||
            fullPath.startsWith(p.path.replace(/[/\\]+$/, "") + sep)),
      )
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) return fullPath;
    const name = getFolderName(root.path);
    const sub = fullPath.substring(root.path.length).replace(/^[/\\]+/, "");
    return sub ? `${name} › ${sub}` : name;
  };

  // Pin a folder or file
  const handlePin = (path: string, isDir: boolean) => {
    if (!pinnedWorkspaces.some((p) => p.path === path)) {
      setPinnedWorkspaces([...pinnedWorkspaces, { path, isDir }]);
    }
  };

  // Unpin a folder or file
  const handleUnpin = (path: string) => {
    setPinnedWorkspaces(pinnedWorkspaces.filter((p) => p.path !== path));
    // On iOS, dropping a picked folder should also release its security-scoped
    // bookmark so we stop holding access to it.
    storage.releaseFolder?.(path).catch((err) =>
      console.error("Failed to release folder:", err)
    );
  };

  // Pick a folder via the native document picker (iOS) and pin it as a
  // workspace, then navigate into it.
  const [isPicking, setIsPicking] = useState(false);
  const handleAddFolder = async () => {
    if (!storage.pickFolder) return;
    setIsPicking(true);
    try {
      const folder = await storage.pickFolder();
      if (folder) {
        handlePin(folder.path, true);
        setCurrentPath(folder.path);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setIsPicking(false);
    }
  };

  // Open terminal at path
  const handleOpenTerminal = () => {
    if (!currentPath) return;
    invoke("open_terminal", { path: currentPath })
      .catch((err) => alert(`Error opening terminal: ${err}`));
    sidebarRef.current?.focus();
  };

  // Begin creating a new file in the current folder
  const startCreateFile = () => {
    setError(null);
    setCreatingFile(true);
    setNewFileName("");
    // Focus the input on the next tick once it has rendered
    setTimeout(() => newFileInputRef.current?.focus(), 0);
  };

  // Create a new (empty) file in the current folder and open it
  const handleCreateFile = async () => {
    const name = newFileName.trim();
    if (!name) {
      setCreatingFile(false);
      sidebarRef.current?.focus();
      return;
    }
    const targetDir = viewMode === "tree" ? treeRootPath : currentPath;
    if (!targetDir) return;
    const isWindows = targetDir.includes("\\");
    const sep = isWindows ? "\\" : "/";
    const fullPath = targetDir.endsWith(sep) ? `${targetDir}${name}` : `${targetDir}${sep}${name}`;

    try {
      await storage.createFile(fullPath);
      setCreatingFile(false);
      setNewFileName("");
      // Refresh listings so the new file shows up
      setReloadToken((t) => t + 1);
      if (viewMode === "tree") {
        try {
          const res = await storage.listDirectory(targetDir);
          setTreeEntries((prev) => ({ ...prev, [targetDir]: res }));
        } catch (err) {
          console.error("Failed to refresh tree directory:", err);
        }
      }
      onSelectFile(fullPath);
    } catch (err) {
      setError(String(err));
    }
  };

  // Central keyboard navigation for the entire sidebar
  const handleSidebarKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (viewMode === "list" && canGoUp() && !loading) {
        handleGoUp();
      }
      return;
    }

    if (activeSection === "workspace") {
      if (sortedPinned.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (focusedWorkspaceIndex < sortedPinned.length - 1) {
          setFocusedWorkspaceIndex((prev) => prev + 1);
        } else if (viewMode === "tree" ? flatNodes.length > 0 : entries.length > 0) {
          setActiveSection("folders");
          if (viewMode === "tree") {
            setFocusedNodeIndex(0);
          } else {
            setFocusedEntryIndex(0);
          }
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedWorkspaceIndex((prev) => (prev > 0 ? prev - 1 : 0));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const index = focusedWorkspaceIndex >= 0 ? focusedWorkspaceIndex : 0;
        if (index >= 0 && index < sortedPinned.length) {
          const item = sortedPinned[index];
          if (item.isDir) {
            setCurrentPath(item.path);
            if (viewMode === "tree") {
              setTreeRootPath(item.path);
            }
          } else {
            onSelectFile(item.path);
          }
        }
      }
    } else if (activeSection === "folders") {
      if (viewMode === "tree") {
        if (flatNodes.length === 0) return;

        const node = flatNodes[focusedNodeIndex >= 0 ? focusedNodeIndex : 0];

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setFocusedNodeIndex((prev) => (prev < flatNodes.length - 1 ? prev + 1 : prev));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (focusedNodeIndex > 0) {
            setFocusedNodeIndex((prev) => prev - 1);
          } else if (sortedPinned.length > 0) {
            setActiveSection("workspace");
            setFocusedWorkspaceIndex(sortedPinned.length - 1);
          }
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          if (node && node.isDir && !expandedPaths[node.path]) {
            toggleExpand(node.path);
          }
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          if (node) {
            if (node.isDir && expandedPaths[node.path]) {
              toggleExpand(node.path);
            } else if (node.parentPath) {
              const pIdx = flatNodes.findIndex(n => n.path === node.parentPath);
              if (pIdx !== -1) {
                setFocusedNodeIndex(pIdx);
              }
            }
          }
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (node) {
            if (node.isDir) {
              toggleExpand(node.path);
            } else {
              onSelectFile(node.path);
            }
          }
        }
      } else {
        if (entries.length === 0) return;

        if (e.key === "ArrowDown") {
          e.preventDefault();
          setFocusedEntryIndex((prev) => (prev < entries.length - 1 ? prev + 1 : prev));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (focusedEntryIndex > 0) {
            setFocusedEntryIndex((prev) => prev - 1);
          } else if (sortedPinned.length > 0) {
            setActiveSection("workspace");
            setFocusedWorkspaceIndex(sortedPinned.length - 1);
          }
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          const index = focusedEntryIndex >= 0 ? focusedEntryIndex : 0;
          if (index >= 0 && index < entries.length) {
            const entry = entries[index];
            const isSelectable = !entry.is_dir;
            
            if (entry.is_dir) {
              setCurrentPath(entry.path);
            } else if (isSelectable) {
              onSelectFile(entry.path);
            }
          }
        }
      }
    }
  };

  return (
    <div
      ref={sidebarRef}
      className="sidebar"
      tabIndex={0}
      onKeyDown={handleSidebarKeyDown}
      onClick={() => sidebarRef.current?.focus()}
      style={{
        width: `${width}px`,
        minWidth: `${width}px`,
        maxWidth: `${width}px`,
        outline: "none", // Prevent default blue focus outline on sidebar
      }}
    >
      <div className="sidebar-header">
        <Folder className="w-4 h-4 text-accent" />
        <span>mdcmd</span>
        <div className="sidebar-header-actions" style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
          <select
            className="sidebar-sort-select"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as "name" | "mtime")}
            style={{ fontSize: "10px", background: "transparent", color: "var(--text-secondary)", border: "none" }}
          >
            <option value="name">Name</option>
            <option value="mtime">Time</option>
          </select>
          <input type="file" id="file-picker" style={{ display: "none" }} onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
               alert("File selected: " + file.name);
            }
          }} />
          <button className="sidebar-action-btn" title="Open file" onClick={() => document.getElementById("file-picker")?.click()}>
            <FilePlus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Workspaces Section (Upper Sidebar Pane) */}
      <div
        className="sidebar-section workspace"
        onClick={() => {
          setActiveSection("workspace");
        }}
        style={{
          height: `${workspaceHeightPercent}%`,
          flex: "none",
        }}
      >
        <div className="sidebar-subheader">
          <span className="sidebar-section-title">
            <Pin className="w-3.5 h-3.5 text-accent" style={{ fill: "var(--accent)" }} />
            <span>Workspaces</span>
          </span>
          {storage.capabilities.documentPicker && (
            <button
              className="file-action-btn"
              tabIndex={-1}
              disabled={isPicking}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                handleAddFolder();
              }}
              title="Add a folder from Files / iCloud Drive"
              style={{ opacity: 0.8 }}
            >
              {isPicking ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FolderPlus className="w-3.5 h-3.5" />
              )}
            </button>
          )}
        </div>
        <div className="sidebar-scroll-content">
          {sortedPinned.length === 0 ? (
            <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)", opacity: 0.7 }}>
              No pinned workspaces.
            </div>
          ) : (
            <div className="workspace-list">
              {sortedPinned.map((item, index) => {
                const isFocused = activeSection === "workspace" && focusedWorkspaceIndex === index;
                return (
                  <div
                    key={item.path}
                    className={`workspace-item ${isFocused ? "keyboard-focused" : ""}`}
                    onClick={() => {
                      setActiveSection("workspace");
                      setFocusedWorkspaceIndex(index);
                      if (item.isDir) {
                        setCurrentPath(item.path);
                        if (viewMode === "tree") {
                          setTreeRootPath(item.path);
                        }
                      } else {
                        onSelectFile(item.path);
                      }
                    }}
                    title={item.path}
                  >
                    <div className="workspace-item-info">
                      {item.isDir ? (
                        <Folder style={{ width: "15px", height: "15px", color: "var(--accent)" }} />
                      ) : (
                        <FileText style={{ width: "15px", height: "15px", color: "var(--text-secondary)" }} />
                      )}
                      <div className="workspace-item-text">
                        <span className="workspace-item-name">{getFolderName(item.path)}</span>
                        <span className="workspace-item-path">{item.path}</span>
                      </div>
                    </div>
                    <div className="workspace-item-actions">
                      <button
                        className="workspace-action-btn"
                        tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleUnpin(item.path);
                          sidebarRef.current?.focus();
                        }}
                        title={item.isDir ? "Unpin folder" : "Unpin file"}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Horizontal Drag Resizer divider */}
      <div className="section-resizer" onMouseDown={startSectionResize} />

      {/* Folders Section (Lower Sidebar Pane) */}
      <div
        className="sidebar-section folders"
        onClick={() => {
          setActiveSection("folders");
        }}
      >
        <div className="sidebar-subheader">
          <span className="sidebar-section-title">
            <Folder className="w-3.5 h-3.5 text-secondary" />
            <span>Folders</span>
          </span>
          {currentPath && (
            <div style={{ display: "flex", gap: "6px" }}>
              <button
                className={`file-action-btn ${viewMode === "tree" ? "active text-accent" : ""}`}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const nextMode = viewMode === "list" ? "tree" : "list";
                  setViewMode(nextMode);
                  if (nextMode === "tree" && currentPath) {
                    setTreeRootPath(currentPath);
                  }
                  sidebarRef.current?.focus();
                }}
                title={viewMode === "list" ? "Switch to Tree View" : "Switch to List View"}
                style={{ opacity: 0.8 }}
              >
                {viewMode === "list" ? <FolderTree className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
              </button>
              <button
                className="file-action-btn"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={startCreateFile}
                title="Create new file in this folder"
                style={{ opacity: 0.8 }}
              >
                <FilePlus className="w-3.5 h-3.5" />
              </button>
              {storage.capabilities.terminal && (
                <button
                  className="file-action-btn"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleOpenTerminal}
                  title="Open terminal in this folder"
                  style={{ opacity: 0.8 }}
                >
                  <TerminalIcon className="w-3.5 h-3.5" />
                </button>
              )}
              {viewMode === "list" && (
                <button
                  className="file-action-btn"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const isCurrentPinned = pinnedWorkspaces.some((p) => p.path === currentPath);
                    if (isCurrentPinned) {
                      handleUnpin(currentPath);
                    } else {
                      handlePin(currentPath, true);
                    }
                    sidebarRef.current?.focus();
                  }}
                  title={pinnedWorkspaces.some((p) => p.path === currentPath) ? "Unpin current folder" : "Pin current folder"}
                  style={{ opacity: 0.8 }}
                >
                  <Pin
                    className={`w-3.5 h-3.5 ${pinnedWorkspaces.some((p) => p.path === currentPath) ? "pinned text-accent" : ""}`}
                  />
                </button>
              )}
            </div>
          )}
        </div>
        <div style={{ padding: "0 12px 8px 12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", backgroundColor: "var(--bg-tertiary)", borderRadius: "4px", padding: "4px 8px", border: "1px solid var(--border)" }}>
            <span style={{ fontSize: "12px", opacity: 0.6 }}>🔍</span>
            <input
              ref={searchInputRef}
              type="text"
              placeholder={searchScope === "workspaces" ? "Search workspaces... (Cmd+Shift+F)" : "Search folder... (Press /)"}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchQuery("");
                  searchInputRef.current?.blur();
                  sidebarRef.current?.focus();
                }
              }}
              style={{
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--text-primary)",
                fontSize: "12px",
                width: "100%",
              }}
            />
            {searchScope === "workspaces" ? (
              <span 
                onClick={() => setSearchScope("folder")}
                style={{
                  fontSize: "10px",
                  fontWeight: 600,
                  backgroundColor: "var(--accent-soft)",
                  color: "var(--accent)",
                  padding: "2px 5px",
                  borderRadius: "3px",
                  flexShrink: 0,
                  cursor: "pointer",
                  userSelect: "none"
                }}
                title="Searching all workspaces. Click to search current folder."
              >
                Workspaces
              </span>
            ) : (
              <span 
                onClick={() => setSearchScope("workspaces")}
                style={{
                  fontSize: "10px",
                  fontWeight: 600,
                  backgroundColor: "var(--bg-secondary)",
                  color: "var(--text-secondary)",
                  padding: "2px 5px",
                  borderRadius: "3px",
                  flexShrink: 0,
                  cursor: "pointer",
                  userSelect: "none"
                }}
                title="Searching current folder. Click to search all pinned workspaces."
              >
                Folder
              </span>
            )}
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery("");
                  sidebarRef.current?.focus();
                }}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", color: "var(--text-secondary)" }}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
        {creatingFile && (
          <div style={{ padding: "0 12px 8px 12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", backgroundColor: "var(--bg-tertiary)", borderRadius: "4px", padding: "4px 8px", border: "1px solid var(--accent)" }}>
              <FilePlus className="w-3.5 h-3.5" style={{ color: "var(--accent)", flexShrink: 0 }} />
              <input
                ref={newFileInputRef}
                type="text"
                placeholder="new-file.md (Enter to create)"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleCreateFile();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCreatingFile(false);
                    setNewFileName("");
                    sidebarRef.current?.focus();
                  }
                }}
                style={{
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: "var(--text-primary)",
                  fontSize: "12px",
                  width: "100%",
                }}
              />
            </div>
          </div>
        )}
        <div className="sidebar-scroll-content">
          {viewMode === "list" && (
            <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
              <button
                className="nav-button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  handleGoUp();
                  sidebarRef.current?.focus();
                }}
                disabled={!canGoUp() || loading}
                title="Go Up"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <div className="path-bar" title={currentPath}>
                <span className="path-ellipsis-left">
                  {displayPath(currentPath) || "Loading path..."}
                </span>
              </div>
            </div>
          )}

          {viewMode === "tree" && (
            <div style={{ display: "flex", gap: "6px", marginBottom: "8px", alignItems: "center" }}>
              <div className="path-bar" title={treeRootPath} style={{ flexGrow: 1, fontSize: "11px", opacity: 0.8 }}>
                <span style={{ flexShrink: 0 }}>🌳</span>
                <span className="path-ellipsis-left">{displayPath(treeRootPath)}</span>
              </div>
            </div>
          )}

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

          {!loading && !error && searchQuery && (
            <div className="file-list">
              {isSearching ? (
                <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)" }}>
                  Searching...
                </div>
              ) : searchResults.length === 0 ? (
                <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)" }}>
                  No results found
                </div>
              ) : (
                searchResults.map((entry) => {
                  const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(entry.name);
                  const isVideo = /\.(mp4|webm|ogg|mov|mkv)$/i.test(entry.name);
                  const isSelectable = !entry.is_dir;
                  const isSelected = selectedFile === entry.path;
                  const isPinned = pinnedWorkspaces.some((p) => p.path === entry.path);
                  
                  let relPath = entry.path;
                  if (searchScope === "workspaces") {
                    const matchingWorkspace = pinnedWorkspaces.find(
                      (p) => p.isDir && entry.path.startsWith(p.path)
                    );
                    if (matchingWorkspace) {
                      const wsName = getFileName(matchingWorkspace.path);
                      const subPath = entry.path.substring(matchingWorkspace.path.length).replace(/^[/\\]/, "");
                      relPath = subPath ? `${wsName} › ${subPath}` : wsName;
                    } else {
                      relPath = getFileName(entry.path);
                    }
                  } else {
                    const root = viewMode === "tree" ? treeRootPath : currentPath;
                    relPath = entry.path.startsWith(root)
                      ? entry.path.substring(root.length).replace(/^[/\\]/, "")
                      : entry.path;
                  }

                  return (
                    <div
                      key={entry.path}
                      className={`file-item ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        setActiveSection("folders");
                        if (entry.is_dir) {
                          setSearchQuery("");
                          setCurrentPath(entry.path);
                          if (viewMode === "tree") {
                            setTreeRootPath(entry.path);
                          }
                        } else if (isSelectable) {
                          onSelectFile(entry.path);
                        }
                      }}
                      style={{
                        opacity: !entry.is_dir && !isSelectable ? 0.45 : 1,
                        cursor: !entry.is_dir && !isSelectable ? "default" : "pointer",
                      }}
                    >
                      <span className="file-item-icon">
                        {entry.is_dir ? (
                          <Folder style={{ width: "16px", height: "16px", color: "var(--text-secondary)", opacity: 0.8 }} />
                        ) : isImage ? (
                          <ImageIcon style={{ width: "16px", height: "16px" }} />
                        ) : isVideo ? (
                          <VideoIcon style={{ width: "16px", height: "16px" }} />
                        ) : (
                          <FileText style={{ width: "16px", height: "16px" }} />
                        )}
                      </span>
                      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, overflow: "hidden" }}>
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontWeight: 500,
                          }}
                        >
                          {entry.name}
                        </span>
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            fontSize: "10px",
                            opacity: 0.6,
                          }}
                        >
                          {relPath || entry.path}
                        </span>
                      </div>

                      <div className="file-item-actions">
                        <button
                          className={`file-action-btn ${isPinned ? "pinned" : ""}`}
                          tabIndex={-1}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isPinned) {
                              handleUnpin(entry.path);
                            } else {
                              handlePin(entry.path, entry.is_dir);
                            }
                            sidebarRef.current?.focus();
                          }}
                          title={isPinned ? "Remove from Workspaces" : "Pin to Workspaces"}
                        >
                          <Pin
                            className={`w-3.5 h-3.5 ${isPinned ? "text-accent" : ""}`}
                          />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {!loading && !error && !searchQuery && viewMode === "list" && (
            <div className="file-list">
              {entries.length === 0 ? (
                <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)" }}>
                  Empty Directory
                </div>
              ) : (
                entries.map((entry, index) => {
                  const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(entry.name);
                  const isVideo = /\.(mp4|webm|ogg|mov|mkv)$/i.test(entry.name);
                  const isSelectable = !entry.is_dir;
                  
                  const isSelected = selectedFile === entry.path;
                  const isPinned = pinnedWorkspaces.some((p) => p.path === entry.path);
                  const isFocused = activeSection === "folders" && focusedEntryIndex === index;
                  
                  return (
                    <div
                      key={entry.path}
                      className={`file-item ${isSelected ? "selected" : ""} ${isFocused ? "keyboard-focused" : ""}`}
                      onClick={() => {
                        setActiveSection("folders");
                        setFocusedEntryIndex(index);
                        if (entry.is_dir) {
                          setCurrentPath(entry.path);
                        } else if (isSelectable) {
                          onSelectFile(entry.path);
                        }
                      }}
                      style={{
                        opacity: !entry.is_dir && !isSelectable ? 0.45 : 1,
                        cursor: !entry.is_dir && !isSelectable ? "default" : "pointer",
                      }}
                    >
                      <span className="file-item-icon">
                        {entry.is_dir ? (
                          <Folder style={{ width: "16px", height: "16px", color: "var(--text-secondary)", opacity: 0.8 }} />
                        ) : isImage ? (
                          <ImageIcon style={{ width: "16px", height: "16px" }} />
                        ) : isVideo ? (
                          <VideoIcon style={{ width: "16px", height: "16px" }} />
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

                      <div className="file-item-actions">
                        <button
                          className={`file-action-btn ${isPinned ? "pinned" : ""}`}
                          tabIndex={-1}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isPinned) {
                              handleUnpin(entry.path);
                            } else {
                              handlePin(entry.path, entry.is_dir);
                            }
                            sidebarRef.current?.focus();
                          }}
                          title={isPinned ? "Remove from Workspaces" : "Pin to Workspaces"}
                        >
                          <Pin
                            className={`w-3.5 h-3.5 ${isPinned ? "text-accent" : ""}`}
                          />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {!loading && !error && !searchQuery && viewMode === "tree" && (
            <div className="file-list">
              {flatNodes.length === 0 ? (
                <div style={{ padding: "16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)" }}>
                  Empty Workspace
                </div>
              ) : (
                flatNodes.map((node, index) => {
                  const isImage = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(node.name);
                  const isVideo = /\.(mp4|webm|ogg|mov|mkv)$/i.test(node.name);
                  const isSelected = selectedFile === node.path;
                  const isPinned = pinnedWorkspaces.some((p) => p.path === node.path);
                  const isFocused = activeSection === "folders" && focusedNodeIndex === index;
                  const isExpanded = expandedPaths[node.path];

                  return (
                    <div
                      key={node.path}
                      className={`file-item ${isSelected ? "selected" : ""} ${isFocused ? "keyboard-focused" : ""}`}
                      onClick={() => {
                        setActiveSection("folders");
                        setFocusedNodeIndex(index);
                        if (node.isDir) {
                          toggleExpand(node.path);
                        } else {
                          onSelectFile(node.path);
                        }
                      }}
                      style={{
                        paddingLeft: `${node.depth * 12 + 8}px`,
                        cursor: "pointer",
                      }}
                    >
                      <span className="file-item-icon" style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                        {node.isDir && (
                          <span style={{ fontSize: "10px", width: "10px", display: "inline-block", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}>
                            ▶
                          </span>
                        )}
                        {node.isDir ? (
                          <Folder style={{ width: "16px", height: "16px", color: "var(--text-secondary)", opacity: 0.8 }} />
                        ) : isImage ? (
                          <ImageIcon style={{ width: "16px", height: "16px" }} />
                        ) : isVideo ? (
                          <VideoIcon style={{ width: "16px", height: "16px" }} />
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
                        {node.name}
                      </span>

                      <div className="file-item-actions">
                        <button
                          className={`file-action-btn ${isPinned ? "pinned" : ""}`}
                          tabIndex={-1}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isPinned) {
                              handleUnpin(node.path);
                            } else {
                              handlePin(node.path, node.isDir);
                            }
                            sidebarRef.current?.focus();
                          }}
                          title={isPinned ? "Remove from Workspaces" : "Pin to Workspaces"}
                        >
                          <Pin
                            className={`w-3.5 h-3.5 ${isPinned ? "text-accent" : ""}`}
                          />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {/* Version box: app version plus the git commit the build came from. */}
      {versionInfo && (
        <div
          className="sidebar-footer"
          title={`mdcmd v${versionInfo.version}\ncommit ${versionInfo.commit}\ncommitted ${versionInfo.commitDate}`}
        >
          <span className="sidebar-footer-version">v{versionInfo.version}</span>
          <span className="sidebar-footer-sep">·</span>
          <span className="sidebar-footer-commit">{versionInfo.commit}</span>
          <span className="sidebar-footer-sep">·</span>
          <span className="sidebar-footer-date">{versionInfo.commitDate}</span>
        </div>
      )}
    </div>
  );
}
