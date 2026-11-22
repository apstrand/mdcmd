import { useEffect, useLayoutEffect, useState, useRef } from "react";
import { useEditor, EditorContent, Extension, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import Link from "@tiptap/extension-link";
import { tableExtensions, tableMenuItems } from "../utils/markdownTable";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Minus,
  Undo2,
  Redo2,
  Save,
  CodeSquare,
  FileEdit,
  Lock,
  ChevronDown,
  ChevronUp,
  X,
  ZoomIn,
  ZoomOut,
  Pin,
  BookOpen,
  Copy,
  FolderOpen,
  FolderSearch,
  Diff,
  Wand2,
  Printer,
  Link as LinkIcon,
} from "lucide-react";
import { rtlTruncate } from "../utils/paths";
import { showContextMenu } from "./ContextMenu";
import { printDocument } from "../utils/printDocument";
import { canRevealInOS, revealInOS, revealLabel } from "../utils/osIntegration";
import { textEditingMenuItems } from "../utils/textActions";

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
const ZOOM_STORAGE_KEY = "mdcmd-editor-zoom";
const CONTENT_THEME_STORAGE_KEY = "mdcmd-content-theme";

const clampZoom = (z: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));

const resolvePath = (basePath: string, relativePath: string) => {
  if (relativePath.startsWith('/') || relativePath.match(/^[A-Za-z]:\\/)) return relativePath;
  
  const isWindows = basePath.includes('\\');
  const separator = isWindows ? '\\' : '/';
  
  const parts = basePath.split(separator);
  parts.pop(); // remove filename
  
  const relParts = relativePath.split(/[\\/]/);
  for (const part of relParts) {
    if (part === '.') continue;
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join(separator);
};

const findMatchesInDoc = (doc: any, query: string, caseSensitive = false) => {
  const matches: { from: number; to: number }[] = [];
  if (!query) return matches;
  
  const searchTerm = caseSensitive ? query : query.toLowerCase();
  
  doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const text = node.text || "";
      const searchText = caseSensitive ? text : text.toLowerCase();
      let index = searchText.indexOf(searchTerm);
      while (index !== -1) {
        matches.push({
          from: pos + index,
          to: pos + index + query.length
        });
        index = searchText.indexOf(searchTerm, index + 1);
      }
    }
  });
  return matches;
};

const findMatchesInText = (text: string, query: string, caseSensitive = false) => {
  const matches: { from: number; to: number }[] = [];
  if (!query) return matches;
  
  const textToSearch = caseSensitive ? text : text.toLowerCase();
  const searchTerm = caseSensitive ? query : query.toLowerCase();
  
  let index = textToSearch.indexOf(searchTerm);
  while (index !== -1) {
    matches.push({
      from: index,
      to: index + query.length
    });
    index = textToSearch.indexOf(searchTerm, index + 1);
  }
  return matches;
};

const replaceAllInDoc = (editor: any, query: string, replacement: string, caseSensitive = false) => {
  const matches = findMatchesInDoc(editor.state.doc, query, caseSensitive);
  const tr = editor.state.tr;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    tr.replaceWith(match.from, match.to, editor.schema.text(replacement));
  }
  editor.view.dispatch(tr);
};

const escapeRegExp = (str: string) => {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const searchHighlightKey = new PluginKey('searchHighlight');

const SearchHighlightExtension = Extension.create({
  name: 'searchHighlight',
  addOptions() {
    return {
      findStateRef: null as any,
    };
  },
  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: searchHighlightKey,
        state: {
          init() {
            return DecorationSet.empty;
          },
          apply(tr) {
            const ref = extension.options.findStateRef;
            if (!ref || !ref.current) return DecorationSet.empty;
            const { searchQuery, caseSensitive, currentMatchIndex, isOpen } = ref.current;
            if (!isOpen || !searchQuery) return DecorationSet.empty;

            const decorations: Decoration[] = [];
            const searchTerm = caseSensitive ? searchQuery : searchQuery.toLowerCase();

            tr.doc.descendants((node, pos) => {
              if (node.isText) {
                const text = node.text || "";
                const searchText = caseSensitive ? text : text.toLowerCase();
                let index = searchText.indexOf(searchTerm);
                while (index !== -1) {
                  const isActive = decorations.length === currentMatchIndex;
                  decorations.push(
                    Decoration.inline(pos + index, pos + index + searchQuery.length, {
                      class: isActive ? 'search-result active-match' : 'search-result',
                    })
                  );
                  index = searchText.indexOf(searchTerm, index + 1);
                }
              }
            });

            return DecorationSet.create(tr.doc, decorations);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

// tiptap-markdown's `markdown` storage is occasionally missing for a tick
// while the editor is being (re)created or torn down. Reading it directly
// (`editor.storage.markdown.getMarkdown()`) then throws "undefined is not an
// object"; when that happens during a React render it unmounts the whole tree
// and leaves a blank white window. Return null when the storage isn't ready so
// callers can fall back to the plain-text content instead of crashing.
/**
 * The bullet character the file itself uses for unordered lists, so a document
 * the user edits comes back out with its own convention rather than being
 * rewritten to the serializer's default. Falls back to "-" (the default) when
 * the file has no list to learn from.
 */
function detectBulletMarker(markdown: string): "-" | "*" | "+" {
  const counts = { "-": 0, "*": 0, "+": 0 };
  for (const line of markdown.split("\n")) {
    const match = line.match(/^\s{0,3}([-*+])\s/);
    if (match) counts[match[1] as "-" | "*" | "+"] += 1;
  }
  const [marker, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] as
    ["-" | "*" | "+", number];
  return count > 0 ? marker : "-";
}

function getEditorMarkdown(editor: Editor | null): string | null {
  const markdown = (editor?.storage as { markdown?: { getMarkdown?: () => string } } | undefined)?.markdown;
  return typeof markdown?.getMarkdown === "function" ? markdown.getMarkdown() : null;
}

interface MarkdownEditorProps {
  filePath: string;
  initialContent: string;
  onSave: (filePath: string, content: string) => Promise<void>;
  onChange?: (filePath: string, content: string) => void;
  /** Shortened, storage-relative path shown under the file name (falls back to
   *  the absolute path). */
  pathLabel?: string;
  onOpenFile?: (path: string) => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  isDirty?: boolean;
  /** When this equals `filePath`, move the cursor to the end and focus the
   *  editor (the iOS Quick Note widget jumping straight into typing). */
  focusAtEndFor?: string | null;
  /** Called right after consuming a matching `focusAtEndFor`. */
  onFocusAtEndHandled?: () => void;
  /** Point the file browser at the folder holding this file. */
  onRevealInFolderList?: (path: string) => void;
  /** Open the "changes since last save" view for this file. */
  onShowChanges?: () => void;
}

export default function MarkdownEditor({
  filePath,
  initialContent,
  onSave,
  onChange,
  pathLabel,
  onOpenFile,
  isPinned,
  onTogglePin,
  focusAtEndFor,
  onFocusAtEndHandled,
  isDirty,
  onRevealInFolderList,
  onShowChanges,
}: MarkdownEditorProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [editMode, setEditMode] = useState<"rich" | "plain">("rich");

  // Reading theme for rendered markdown: "reading" favors long-form prose
  // (serif, narrower measure), "clarity" favors technical docs (wider, tight
  // sans-serif). Shared across files and persisted like zoom.
  const [contentTheme, setContentTheme] = useState<"default" | "reading" | "clarity">(() => {
    try {
      const saved = localStorage.getItem(CONTENT_THEME_STORAGE_KEY);
      return saved === "reading" || saved === "clarity" ? saved : "default";
    } catch {
      return "default";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(CONTENT_THEME_STORAGE_KEY, contentTheme);
    } catch {
      // ignore storage errors (e.g. private browsing)
    }
  }, [contentTheme]);

  // Zoom level for the markdown/plain content area. Shared across files and
  // persisted so it survives reopening a file or restarting the app.
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
      return saved ? clampZoom(saved) : 1;
    } catch {
      return 1;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
    } catch {
      // ignore quota / private-mode failures
    }
  }, [zoom]);

  const zoomIn = () => setZoom((z) => clampZoom(z + ZOOM_STEP));
  const zoomOut = () => setZoom((z) => clampZoom(z - ZOOM_STEP));
  const zoomReset = () => setZoom(1);

  const isMarkdown = filePath.toLowerCase().endsWith(".md") || filePath.toLowerCase().endsWith(".qmd");
  const isEditable = true;

  const [plainContent, setPlainContent] = useState(initialContent);

  // Per-file scroll position: remember where the user was and restore it when
  // the file is reopened (from an argument, a tab, or the file browser). A file
  // that was never opened has no saved position, so it starts at the top instead
  // of jumping to the end (see autofocus below).
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const plainTextareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollStorageKey = `mdcmd-scroll:${filePath}`;
  const latestScrollRef = useRef(0);
  const scrollFlushRef = useRef<number | null>(null);

  const readSavedScroll = () => {
    try {
      return Number(localStorage.getItem(scrollStorageKey)) || 0;
    } catch {
      return 0;
    }
  };

  // Throttle writes so scrolling doesn't hammer localStorage on every event.
  const rememberScroll = (top: number) => {
    latestScrollRef.current = top;
    if (scrollFlushRef.current != null) return;
    scrollFlushRef.current = window.setTimeout(() => {
      scrollFlushRef.current = null;
      try {
        localStorage.setItem(scrollStorageKey, String(latestScrollRef.current));
      } catch {
        // ignore quota / private-mode failures
      }
    }, 150);
  };

  const [findState, setFindState] = useState<{
    isOpen: boolean;
    searchQuery: string;
    replaceQuery: string;
    caseSensitive: boolean;
    currentMatchIndex: number;
  }>({
    isOpen: false,
    searchQuery: "",
    replaceQuery: "",
    caseSensitive: false,
    currentMatchIndex: 0,
  });

  const findStateRef = useRef(findState);
  useEffect(() => {
    findStateRef.current = findState;
  }, [findState]);

  // The small "set link" popover (Cmd+K), anchored under the selection.
  const [linkEditor, setLinkEditor] = useState<{
    open: boolean;
    url: string;
    top: number;
    left: number;
  }>({ open: false, url: "", top: 0, left: 0 });
  const linkInputRef = useRef<HTMLInputElement>(null);

  // Round-tripping markdown through the rich editor is lossy in cosmetic ways
  // (list markers, escaping, blank lines), so the serialized text of a file
  // nobody has touched rarely matches the bytes on disk. Comparing against this
  // baseline — the serialization of the document as it was *loaded* — is what
  // tells a real edit apart from that reformatting, so merely opening a file
  // neither marks it dirty nor rewrites it on save.
  const baselineMarkdownRef = useRef<string | null>(null);
  // Set by the explicit "Reformat document" action: from then on the file
  // counts as changed even if the user hasn't typed anything.
  const [reformatRequested, setReformatRequested] = useState(false);
  const reformatRequestedRef = useRef(false);
  reformatRequestedRef.current = reformatRequested;

  /** The content to hand upwards for the editor's current document. */
  const contentFor = (markdown: string) => {
    if (!reformatRequestedRef.current && markdown === baselineMarkdownRef.current) {
      return initialContent;
    }
    // The serializer drops the file's final newline; keeping it spares every
    // edited file a "\ No newline at end of file" line in its next diff.
    return initialContent.endsWith("\n") && !markdown.endsWith("\n")
      ? `${markdown}\n`
      : markdown;
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({}),
      Markdown.configure({
        bulletListMarker: detectBulletMarker(initialContent),
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      ...tableExtensions,
      SearchHighlightExtension.configure({
        findStateRef: findStateRef,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
      }),
    ],
    content: isMarkdown ? initialContent : "",
    editable: isMarkdown,
    // Scrolling is handled by the scroll-restore effects below; don't force the
    // cursor (and viewport) to the end of the document on open.
    autofocus: false,
    editorProps: {
      attributes: {
        class: "ProseMirror",
      },
      handleClick(view, pos, event) {
        if (event.metaKey || event.ctrlKey) {
          const state = view.state;
          const $pos = state.doc.resolve(pos);
          const node = state.doc.nodeAt(pos) || $pos.nodeAfter || $pos.nodeBefore;
          
          if (node && node.marks) {
            const linkMark = node.marks.find(m => m.type.name === 'link');
            if (linkMark && onOpenFile) {
              const href = linkMark.attrs.href;
              onOpenFile(resolvePath(filePath, href));
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
          }
          
          // Also check text under cursor just in case it looks like a path without a link
          if (node && node.isText && onOpenFile) {
            const text = node.text || "";
            const nodeStart = $pos.start() + $pos.parentOffset - (node.nodeSize - 1);
            const localPos = Math.max(0, pos - nodeStart);
            const leftStr = text.substring(0, localPos);
            const rightStr = text.substring(localPos);
            const matchLeft = leftStr.match(/([^\s"'\(\)\[\]]+)$/);
            const matchRight = rightStr.match(/^([^\s"'\(\)\[\]]+)/);
            const word = (matchLeft ? matchLeft[1] : '') + (matchRight ? matchRight[1] : '');
            
            if (word && (word.includes('.md') || word.includes('.txt') || word.includes('/'))) {
              onOpenFile(resolvePath(filePath, word));
              event.preventDefault();
              event.stopPropagation();
              return true;
            }
          }
        }
        return false;
      }
    },
    onUpdate: ({ editor }) => {
      if (isMarkdown) {
        const md = getEditorMarkdown(editor);
        if (md === null) return;
        setPlainContent(md);
        onChange?.(filePath, contentFor(md));
      }
    }
  });

  // Take the baseline as soon as the editor exists — in a layout effect, so it
  // is in place before anything the user can do, and before the first paint.
  // Creating the editor can itself change the document (autolinking, list
  // normalisation), which fires `onUpdate` while the baseline is still unknown
  // and briefly reports the file as changed; re-reporting here settles that
  // back to "unchanged" within the same commit.
  useLayoutEffect(() => {
    if (!editor || !isMarkdown || baselineMarkdownRef.current !== null) return;
    const md = getEditorMarkdown(editor);
    if (md === null) return;
    baselineMarkdownRef.current = md;
    onChange?.(filePath, contentFor(md));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Restore the saved scroll position for the rich editor once it is ready.
  // No saved value means "never opened before" -> stay at the top (0).
  // Exception: the Quick Note widget wants the cursor at the *end*, ready to
  // type a new line, instead of wherever the file was last scrolled to.
  useEffect(() => {
    if (!editor || editMode !== "rich") return;
    const el = editorContainerRef.current;
    if (!el) return;

    if (focusAtEndFor === filePath) {
      requestAnimationFrame(() => {
        editor.commands.setTextSelection(editor.state.doc.content.size);
        editor.commands.focus(undefined, { scrollIntoView: true });
        onFocusAtEndHandled?.();
      });
      return;
    }

    const saved = readSavedScroll();
    latestScrollRef.current = saved;
    // Two frames: the first lets ProseMirror lay out the content, the second
    // applies the scroll once the real height is known.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        el.scrollTop = saved;
        // Allow typing without ProseMirror yanking the viewport to the cursor.
        editor.commands.focus(undefined, { scrollIntoView: false });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Restore the saved scroll position for the plain-text / non-markdown view.
  // Same Quick Note exception as the rich-editor effect above.
  useEffect(() => {
    const usesTextarea = !isMarkdown || editMode === "plain";
    if (!usesTextarea) return;
    const el = plainTextareaRef.current;
    if (!el) return;

    if (focusAtEndFor === filePath) {
      requestAnimationFrame(() => {
        const end = el.value.length;
        el.setSelectionRange(end, end);
        el.focus();
        el.scrollTop = el.scrollHeight;
        onFocusAtEndHandled?.();
      });
      return;
    }

    const saved = readSavedScroll();
    latestScrollRef.current = saved;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = saved;
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode]);

  // Flush the latest scroll position when the file closes / another is opened.
  useEffect(() => {
    return () => {
      if (scrollFlushRef.current != null) {
        clearTimeout(scrollFlushRef.current);
        scrollFlushRef.current = null;
      }
      try {
        localStorage.setItem(scrollStorageKey, String(latestScrollRef.current));
      } catch {
        // ignore quota / private-mode failures
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollStorageKey]);

  // Declaratively update ProseMirror search highlights when findState changes or editor is re-attached
  useEffect(() => {
    if (editor && editMode === "rich") {
      editor.view.dispatch(editor.state.tr);
    }
  }, [findState.searchQuery, findState.caseSensitive, findState.currentMatchIndex, findState.isOpen, editMode, editor]);

  // Sync plain text content back to Tiptap editor when switching to rich mode
  useEffect(() => {
    if (editMode === "rich" && editor) {
      const currentMd = getEditorMarkdown(editor);
      if (currentMd !== null && currentMd !== plainContent) {
        editor.commands.setContent(plainContent);
      }
    }
  }, [editMode, editor, plainContent]);

  const getMatches = (query: string, caseSensitive: boolean) => {
    if (!query) return [];
    if (editMode === "rich" && editor) {
      return findMatchesInDoc(editor.state.doc, query, caseSensitive);
    } else {
      return findMatchesInText(plainContent, query, caseSensitive);
    }
  };

  const goToMatch = (index: number, matches: { from: number; to: number }[]) => {
    if (matches.length === 0 || index < 0 || index >= matches.length) return;
    const match = matches[index];
    
    if (editMode === "rich" && editor) {
      setFindState(prev => ({ ...prev, currentMatchIndex: index }));

      const tr = editor.state.tr;
      const resolvedPos = tr.doc.resolve(match.from);
      tr.setSelection(new TextSelection(resolvedPos, tr.doc.resolve(match.to)));
      tr.scrollIntoView();
      editor.view.dispatch(tr);

      // ProseMirror's own scrollIntoView only fires reliably when the editor
      // holds focus — but during Find the focus is in the search box, so it's a
      // no-op and the match stays off-screen. Scroll the container to the match
      // ourselves, after a frame so the new selection has been laid out.
      requestAnimationFrame(() => {
        const el = editorContainerRef.current;
        if (!el || !editor) return;
        try {
          const coords = editor.view.coordsAtPos(match.from);
          const box = el.getBoundingClientRect();
          const margin = 80;
          if (coords.top < box.top + margin) {
            el.scrollTop += coords.top - (box.top + margin);
          } else if (coords.bottom > box.bottom - margin) {
            el.scrollTop += coords.bottom - (box.bottom - margin);
          }
        } catch {
          // coordsAtPos can throw mid-update; the next navigation will retry.
        }
      });
    } else {
      const textarea = document.querySelector(".plain-text-editor") as HTMLTextAreaElement;
      if (textarea) {
        const activeElement = document.activeElement as HTMLElement;
        textarea.focus();
        textarea.setSelectionRange(match.from, match.to);
        if (activeElement && activeElement !== textarea) {
          activeElement.focus();
        }
      }
    }
  };

  // Open the Cmd+K link popover for the current selection. Needs selected text
  // to wrap (or the caret inside an existing link, to edit it); otherwise there
  // is nothing to turn into a link. Pre-fills any existing href and anchors the
  // input just below the selection.
  const openLinkEditor = () => {
    if (editMode !== "rich" || !editor) return;
    const { from, to } = editor.state.selection;
    const existingHref: string = editor.getAttributes("link").href || "";
    if (from === to && !existingHref) return;

    let top = 0;
    let left = 0;
    try {
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      top = Math.max(start.bottom, end.bottom) + 6;
      left = start.left;
    } catch {
      // Fall back to the top-left if the selection can't be measured.
    }
    setLinkEditor({ open: true, url: existingHref, top, left });
    requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
  };

  const closeLinkEditor = () => {
    setLinkEditor((prev) => ({ ...prev, open: false }));
    editor?.commands.focus();
  };

  // Apply the typed/pasted URL to the stored selection (a blank URL removes the
  // link). `extendMarkRange` lets an edit from inside an existing link cover the
  // whole link even without a selection.
  const applyLinkEditor = () => {
    if (!editor) return;
    const url = linkEditor.url.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (url) {
      chain.setLink({ href: url }).run();
    } else {
      chain.unsetLink().run();
    }
    setLinkEditor((prev) => ({ ...prev, open: false }));
  };

  const handleSearchChange = (query: string) => {
    setFindState(prev => ({ ...prev, searchQuery: query, currentMatchIndex: 0 }));
  };

  const handleCaseToggle = () => {
    setFindState(prev => ({ ...prev, caseSensitive: !prev.caseSensitive, currentMatchIndex: 0 }));
  };

  const handleFindNext = () => {
    const query = findState.searchQuery;
    if (!query) return;
    const matches = getMatches(query, findState.caseSensitive);
    if (matches.length === 0) return;
    
    const nextIndex = (findState.currentMatchIndex + 1) % matches.length;
    setFindState(prev => ({ ...prev, currentMatchIndex: nextIndex }));
    goToMatch(nextIndex, matches);
  };

  const handleFindPrev = () => {
    const query = findState.searchQuery;
    if (!query) return;
    const matches = getMatches(query, findState.caseSensitive);
    if (matches.length === 0) return;
    
    const prevIndex = (findState.currentMatchIndex - 1 + matches.length) % matches.length;
    setFindState(prev => ({ ...prev, currentMatchIndex: prevIndex }));
    goToMatch(prevIndex, matches);
  };

  const handleReplace = () => {
    const query = findState.searchQuery;
    if (!query) return;
    const matches = getMatches(query, findState.caseSensitive);
    if (matches.length === 0) return;
    
    const index = findState.currentMatchIndex;
    const match = matches[index];
    if (!match) return;
    
    const replacement = findState.replaceQuery;
    
    if (editMode === "rich" && editor) {
      editor.commands.setTextSelection({ from: match.from, to: match.to });
      editor.commands.insertContent(replacement);
      
      setTimeout(() => {
        const newMatches = getMatches(query, findState.caseSensitive);
        if (newMatches.length > 0) {
          const nextIndex = index % newMatches.length;
          setFindState(prev => ({ ...prev, currentMatchIndex: nextIndex }));
          goToMatch(nextIndex, newMatches);
        } else {
          setFindState(prev => ({ ...prev, currentMatchIndex: 0 }));
        }
      }, 0);
    } else {
      const newContent = plainContent.substring(0, match.from) + replacement + plainContent.substring(match.to);
      setPlainContent(newContent);
      onChange?.(filePath, newContent);
      
      setTimeout(() => {
        const newMatches = findMatchesInText(newContent, query, findState.caseSensitive);
        if (newMatches.length > 0) {
          const nextIndex = index % newMatches.length;
          setFindState(prev => ({ ...prev, currentMatchIndex: nextIndex }));
          goToMatch(nextIndex, newMatches);
        } else {
          setFindState(prev => ({ ...prev, currentMatchIndex: 0 }));
        }
      }, 0);
    }
  };

  const handleReplaceAll = () => {
    const query = findState.searchQuery;
    if (!query) return;
    const replacement = findState.replaceQuery;
    
    if (editMode === "rich" && editor) {
      replaceAllInDoc(editor, query, replacement, findState.caseSensitive);
      const md = getEditorMarkdown(editor);
      if (md !== null) {
        setPlainContent(md);
        onChange?.(filePath, md);
      }
    } else {
      const regex = new RegExp(escapeRegExp(query), findState.caseSensitive ? 'g' : 'gi');
      const newContent = plainContent.replace(regex, replacement);
      setPlainContent(newContent);
      onChange?.(filePath, newContent);
    }
    
    setFindState(prev => ({ ...prev, currentMatchIndex: 0 }));
  };

  const handleCloseFind = () => {
    setFindState(prev => ({ ...prev, isOpen: false, searchQuery: "" }));
  };





  // Handle Save operation
  const handleSave = async () => {
    setIsSaving(true);

    let contentToSave = "";
    if (isMarkdown) {
      if (editMode === "rich" && editor) {
        const md = getEditorMarkdown(editor);
        // `contentFor` keeps the file's own text when the document only
        // differs by the editor's round-trip formatting, so saving a file
        // nobody edited leaves it byte-for-byte as it was.
        contentToSave = md === null ? plainContent : contentFor(md);
      } else {
        contentToSave = plainContent;
      }
    } else {
      contentToSave = plainContent;
    }

    try {
      await onSave(filePath, contentToSave);

      // Keep rich and plain views in sync after saving
      if (isMarkdown) {
        if (editMode === "rich") {
          setPlainContent(contentToSave);
        } else {
          editor?.commands.setContent(contentToSave);
        }
      }
    } catch (err) {
      console.error("Failed to save:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleMode = (mode: "rich" | "plain") => {
    if (mode === "plain") {
      const md = getEditorMarkdown(editor);
      if (md !== null) {
        setPlainContent(contentFor(md));
      }
    }
    setEditMode(mode);
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch((err) =>
      console.error("Clipboard copy failed:", err),
    );
  };

  /** The file-level actions, shared by the header and the document body. */
  const fileMenuItems = () => [
    {
      label: "Copy full path",
      icon: <Copy className="w-3.5 h-3.5" />,
      onSelect: () => copyText(filePath),
    },
    {
      label: "Copy file name",
      icon: <FileEdit className="w-3.5 h-3.5" />,
      onSelect: () => copyText(getFileName(filePath)),
    },
    onRevealInFolderList && {
      label: "Show in folder list",
      icon: <FolderSearch className="w-3.5 h-3.5" />,
      separatorBefore: true,
      onSelect: () => onRevealInFolderList(filePath),
    },
    canRevealInOS && {
      label: revealLabel,
      icon: <FolderOpen className="w-3.5 h-3.5" />,
      onSelect: () => {
        revealInOS(filePath).catch((err) =>
          console.error("Failed to reveal path:", err),
        );
      },
    },
    onShowChanges && {
      label: "Show changes",
      icon: <Diff className="w-3.5 h-3.5" />,
      disabled: !isDirty,
      separatorBefore: true,
      onSelect: onShowChanges,
    },
    onTogglePin && {
      label: isPinned ? "Remove from shortcuts" : "Pin to shortcuts",
      icon: <Pin className="w-3.5 h-3.5" />,
      onSelect: onTogglePin,
    },
    isMarkdown && {
      label: "Reformat document",
      icon: <Wand2 className="w-3.5 h-3.5" />,
      separatorBefore: true,
      onSelect: reformatDocument,
    },
    {
      label: "Print / Export as PDF…",
      icon: <Printer className="w-3.5 h-3.5" />,
      separatorBefore: !isMarkdown,
      onSelect: handlePrint,
    },
  ];

  /**
   * Rewrite the document in the editor's own markdown style — the opt-in
   * counterpart to leaving untouched files alone. Marks the file dirty so the
   * reformatting is saved like any other edit (and can be undone by closing
   * without saving).
   */
  const reformatDocument = () => {
    const md = editMode === "rich" ? getEditorMarkdown(editor) : plainContent;
    if (md === null) return;
    reformatRequestedRef.current = true;
    setReformatRequested(true);
    const reformatted = contentFor(md);
    setPlainContent(reformatted);
    onChange?.(filePath, reformatted);
  };

  /**
   * Lay the document out as a clean page and open the OS print dialog, whose
   * "Save as PDF" doubles as the export path. Reads the live content (the
   * editor's serialized markdown in rich mode, the textarea otherwise) so
   * unsaved edits are included, and carries the chosen reading theme through.
   */
  const handlePrint = () => {
    const md = editMode === "rich" ? getEditorMarkdown(editor) : plainContent;
    const content = md === null ? plainContent : md;
    printDocument(content, getFileName(filePath), isMarkdown, contentTheme);
  };

  // Intercept Shift+Tab to focus the sidebar folder view — but only when it
  // wouldn't otherwise outdent a list item, so list formatting still works.
  const handleKeyDownCapture = (e: React.KeyboardEvent) => {
    if (e.key === "Tab" && e.shiftKey) {
      if (editor?.can().liftListItem("listItem") || editor?.can().liftListItem("taskItem")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      (document.querySelector(".sidebar") as HTMLElement)?.focus();
    }
  };

  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  });

  const handleFindNextRef = useRef(handleFindNext);
  const handleFindPrevRef = useRef(handleFindPrev);
  useEffect(() => {
    handleFindNextRef.current = handleFindNext;
    handleFindPrevRef.current = handleFindPrev;
  });

  const handlePrintRef = useRef(handlePrint);
  useEffect(() => {
    handlePrintRef.current = handlePrint;
  });

  const openLinkEditorRef = useRef(openLinkEditor);
  useEffect(() => {
    openLinkEditorRef.current = openLinkEditor;
  });

  // Keyboard shortcut Ctrl+S / Cmd+S for saving, Cmd+F for find, Cmd+G for find next, Cmd+Shift+G for find prev,
  // Cmd+` to toggle between rich text and plain text editing.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCmd = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (e.metaKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        handleToggleMode(editMode === "rich" ? "plain" : "rich");
      } else if (isCmd && key === "s") {
        e.preventDefault();
        handleSaveRef.current();
      } else if (isCmd && key === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handlePrintRef.current();
      } else if (isCmd && key === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openLinkEditorRef.current();
      } else if (isCmd && key === "f") {
        e.preventDefault();
        setFindState(prev => {
          if (prev.isOpen) {
            const input = document.getElementById("editor-search-input");
            if (input) {
              input.focus();
              (input as HTMLInputElement).select();
            }
            return prev;
          }
          return { ...prev, isOpen: true };
        });
        
        setTimeout(() => {
          const input = document.getElementById("editor-search-input");
          if (input) {
            input.focus();
            (input as HTMLInputElement).select();
          }
        }, 50);
      } else if (isCmd && key === "g") {
        e.preventDefault();
        if (e.shiftKey) {
          handleFindPrevRef.current();
        } else {
          handleFindNextRef.current();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editMode, editor]);

  // Keyboard zoom: Cmd/Ctrl with '+'/'=' zooms in, '-' out, '0' resets.
  useEffect(() => {
    const handleZoomKeys = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom((z) => clampZoom(z + ZOOM_STEP));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => clampZoom(z - ZOOM_STEP));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", handleZoomKeys);
    return () => window.removeEventListener("keydown", handleZoomKeys);
  }, []);

  // Ctrl/Cmd + mouse wheel (or trackpad pinch, which browsers report as a
  // ctrlKey wheel event) zooms the content area. React's onWheel is passive, so
  // attach a native non-passive listener to allow preventDefault.
  useEffect(() => {
    const el = editorContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
      setZoom((z) => clampZoom(z + delta));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (isMarkdown && !editor) {
    return (
      <div style={{ display: "flex", flexGrow: 1, alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>
        Initializing editor...
      </div>
    );
  }

  const getFileName = (path: string) => {
    const isWindows = path.includes("\\");
    const separator = isWindows ? "\\" : "/";
    return path.substring(path.lastIndexOf(separator) + 1);
  };

  const activeMatches = getMatches(findState.searchQuery, findState.caseSensitive);
  const matchCount = activeMatches.length;
  const currentMatchDisplay = matchCount > 0 ? findState.currentMatchIndex + 1 : 0;

  return (
    <div className="main-panel" onKeyDownCapture={handleKeyDownCapture}>
      <div className="editor-header">
        <div className="file-info">
          <div
            className="file-title-container"
            onContextMenu={(e) => showContextMenu(e, fileMenuItems())}
          >
            <FileEdit className="w-5 h-5 text-accent" style={{ flexShrink: 0 }} />
            <div className="file-title-lines">
              <div className="file-name-text">{getFileName(filePath)}</div>
              <div
                className="file-path-text"
                title={filePath}
                // What's shown is a shortened, right-to-left-truncated label,
                // so selecting it would otherwise copy mangled fragments of
                // the path. Anyone copying a path wants the real, absolute
                // one, so hand that over instead.
                onCopy={(e) => {
                  e.clipboardData.setData("text/plain", filePath);
                  e.preventDefault();
                }}
              >
                {rtlTruncate(pathLabel || filePath)}
              </div>
            </div>
            {onTogglePin && (
              <button
                className={`file-action-btn ${isPinned ? "pinned" : ""}`}
                onClick={onTogglePin}
                title={isPinned ? "Remove from Shortcuts" : "Pin to Shortcuts"}
                style={{ marginLeft: "8px", flexShrink: 0 }}
              >
                <Pin className={`w-3.5 h-3.5 ${isPinned ? "text-accent" : ""}`} />
              </button>
            )}
          </div>

          {isMarkdown && (
            <div className="mode-toggle-container" style={{ display: "flex", borderRadius: "6px", backgroundColor: "var(--bg-tertiary)", padding: "2px", border: "1px solid var(--border)", marginLeft: "16px" }}>
              <button
                onClick={() => handleToggleMode("rich")}
                style={{
                  padding: "4px 10px",
                  fontSize: "12px",
                  fontWeight: 500,
                  borderRadius: "4px",
                  border: "none",
                  cursor: "pointer",
                  backgroundColor: editMode === "rich" ? "var(--bg-primary)" : "transparent",
                  color: editMode === "rich" ? "var(--text-primary)" : "var(--text-secondary)",
                  boxShadow: editMode === "rich" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  transition: "all 0.15s ease"
                }}
              >
                Rich Text
              </button>
              <button
                onClick={() => handleToggleMode("plain")}
                style={{
                  padding: "4px 10px",
                  fontSize: "12px",
                  fontWeight: 500,
                  borderRadius: "4px",
                  border: "none",
                  cursor: "pointer",
                  backgroundColor: editMode === "plain" ? "var(--bg-primary)" : "transparent",
                  color: editMode === "plain" ? "var(--text-primary)" : "var(--text-secondary)",
                  boxShadow: editMode === "plain" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                  transition: "all 0.15s ease"
                }}
              >
                Plain Text
              </button>
            </div>
          )}

          {isMarkdown && editMode === "rich" && (
            <div
              className="theme-select-container"
              style={{ display: "flex", alignItems: "center", gap: "5px", marginLeft: "10px" }}
              title="Reading theme for rendered markdown"
            >
              <BookOpen className="w-3.5 h-3.5" style={{ color: "var(--text-secondary)", flexShrink: 0 }} />
              <select
                value={contentTheme}
                onChange={(e) => setContentTheme(e.target.value as "default" | "reading" | "clarity")}
                style={{
                  fontSize: "12px",
                  fontWeight: 500,
                  borderRadius: "4px",
                  border: "1px solid var(--border)",
                  backgroundColor: "var(--bg-tertiary)",
                  color: "var(--text-primary)",
                  padding: "4px 6px",
                  cursor: "pointer",
                }}
              >
                <option value="default">Default</option>
                <option value="reading">Reading</option>
                <option value="clarity">Clarity</option>
              </select>
            </div>
          )}

          <div className="zoom-controls" title="Zoom (Cmd/Ctrl +/-/0, Cmd/Ctrl + scroll)">
            <button className="zoom-btn" onClick={zoomOut} title="Zoom out" aria-label="Zoom out">
              <ZoomOut className="w-4 h-4" />
            </button>
            <button
              className="zoom-level"
              onClick={zoomReset}
              title="Reset zoom"
              aria-label="Reset zoom"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button className="zoom-btn" onClick={zoomIn} title="Zoom in" aria-label="Zoom in">
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>

          <button
            className="file-action-btn"
            onClick={handlePrint}
            title="Print / Export as PDF"
            aria-label="Print or export as PDF"
            style={{ marginLeft: "8px", flexShrink: 0 }}
          >
            <Printer className="w-4 h-4" />
          </button>

          <div className="save-status">
            {isEditable ? (
              <>
                <button
                  className="save-button"
                  onClick={handleSave}
                  disabled={isSaving || !isDirty}
                >
                  <Save className="w-4 h-4" />
                  {isSaving ? "Saving..." : "Save"}
                </button>
              </>
            ) : (
              <span style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "4px 8px", backgroundColor: "var(--bg-tertiary)", borderRadius: "4px", color: "var(--text-secondary)" }}>
                <Lock className="w-3.5 h-3.5" /> Read Only
              </span>
            )}
          </div>
        </div>

        {/* Visual formatting toolbar */}
        {isMarkdown && editMode === "rich" && editor && (
          <div className="editor-toolbar">
            <button
              onClick={() => editor.chain().focus().toggleBold().run()}
              disabled={!editor.can().chain().focus().toggleBold().run()}
              className={`toolbar-btn ${editor.isActive("bold") ? "active" : ""}`}
              title="Bold (Cmd+B)"
            >
              <Bold className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleItalic().run()}
              disabled={!editor.can().chain().focus().toggleItalic().run()}
              className={`toolbar-btn ${editor.isActive("italic") ? "active" : ""}`}
              title="Italic (Cmd+I)"
            >
              <Italic className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleStrike().run()}
              disabled={!editor.can().chain().focus().toggleStrike().run()}
              className={`toolbar-btn ${editor.isActive("strike") ? "active" : ""}`}
              title="Strikethrough"
            >
              <Strikethrough className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleCode().run()}
              disabled={!editor.can().chain().focus().toggleCode().run()}
              className={`toolbar-btn ${editor.isActive("code") ? "active" : ""}`}
              title="Inline Code"
            >
              <Code className="w-4 h-4" />
            </button>
            <button
              onClick={openLinkEditor}
              className={`toolbar-btn ${editor.isActive("link") ? "active" : ""}`}
              title="Add Link (Cmd+K)"
            >
              <LinkIcon className="w-4 h-4" />
            </button>

            <div className="toolbar-divider" />

            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              className={`toolbar-btn ${editor.isActive("heading", { level: 1 }) ? "active" : ""}`}
              title="Heading 1"
            >
              <Heading1 className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              className={`toolbar-btn ${editor.isActive("heading", { level: 2 }) ? "active" : ""}`}
              title="Heading 2"
            >
              <Heading2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              className={`toolbar-btn ${editor.isActive("heading", { level: 3 }) ? "active" : ""}`}
              title="Heading 3"
            >
              <Heading3 className="w-4 h-4" />
            </button>

            <div className="toolbar-divider" />

            <button
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              className={`toolbar-btn ${editor.isActive("bulletList") ? "active" : ""}`}
              title="Bullet List"
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              className={`toolbar-btn ${editor.isActive("orderedList") ? "active" : ""}`}
              title="Ordered List"
            >
              <ListOrdered className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleTaskList().run()}
              className={`toolbar-btn ${editor.isActive("taskList") ? "active" : ""}`}
              title="Checklist"
            >
              <CheckSquare className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              className={`toolbar-btn ${editor.isActive("blockquote") ? "active" : ""}`}
              title="Blockquote"
            >
              <Quote className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().toggleCodeBlock().run()}
              className={`toolbar-btn ${editor.isActive("codeBlock") ? "active" : ""}`}
              title="Code Block"
            >
              <CodeSquare className="w-4 h-4" />
            </button>

            <div className="toolbar-divider" />

            <button
              onClick={() => editor.chain().focus().setHorizontalRule().run()}
              className="toolbar-btn"
              title="Horizontal Rule"
            >
              <Minus className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().undo().run()}
              disabled={!editor.can().chain().focus().undo().run()}
              className="toolbar-btn"
              title="Undo"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => editor.chain().focus().redo().run()}
              disabled={!editor.can().chain().focus().redo().run()}
              className="toolbar-btn"
              title="Redo"
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {findState.isOpen && (
        <div className="find-replace-bar">
          <div className="find-replace-row">
            <div className="find-replace-input-wrapper">
              <input
                id="editor-search-input"
                className="find-replace-input"
                placeholder="Find"
                value={findState.searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (e.shiftKey) {
                      handleFindPrev();
                    } else {
                      handleFindNext();
                    }
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    handleCloseFind();
                  }
                }}
              />
              {findState.searchQuery && (
                <span className="find-replace-match-count">
                  {currentMatchDisplay} of {matchCount}
                </span>
              )}
            </div>
            
            <button className="find-replace-btn" onClick={handleFindPrev} title="Previous Match (Cmd+Shift+G)">
              <ChevronUp className="w-4 h-4" />
            </button>
            <button className="find-replace-btn" onClick={handleFindNext} title="Next Match (Cmd+G)">
              <ChevronDown className="w-4 h-4" />
            </button>
            
            <label className="find-replace-toggle">
              <input
                type="checkbox"
                checked={findState.caseSensitive}
                onChange={handleCaseToggle}
              />
              Match Case
            </label>
            
            <button className="find-replace-btn" onClick={handleCloseFind} style={{ marginLeft: "auto", border: "none", background: "transparent" }}>
              <X className="w-4 h-4" />
            </button>
          </div>
          
          <div className="find-replace-row">
            <div className="find-replace-input-wrapper">
              <input
                className="find-replace-input"
                placeholder="Replace"
                value={findState.replaceQuery}
                onChange={(e) => {
                  const val = e.target.value;
                  setFindState(prev => ({ ...prev, replaceQuery: val }));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleReplace();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    handleCloseFind();
                  }
                }}
              />
            </div>
            <button className="find-replace-btn" onClick={handleReplace}>
              Replace
            </button>
            <button className="find-replace-btn" onClick={handleReplaceAll}>
              Replace All
            </button>
          </div>
        </div>
      )}

      {linkEditor.open && (
        <>
          {/* Click-away layer to dismiss the popover. */}
          <div
            onMouseDown={closeLinkEditor}
            style={{ position: "fixed", inset: 0, zIndex: 50 }}
          />
          <div
            style={{
              position: "fixed",
              top: linkEditor.top,
              left: linkEditor.left,
              zIndex: 51,
              display: "flex",
              alignItems: "center",
              gap: "6px",
              background: "var(--bg-primary)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              padding: "6px 8px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            }}
          >
            <LinkIcon
              className="w-3.5 h-3.5"
              style={{ color: "var(--text-secondary)", flexShrink: 0 }}
            />
            <input
              ref={linkInputRef}
              className="find-replace-input"
              placeholder="Paste or type a link…"
              value={linkEditor.url}
              onChange={(e) => {
                const v = e.target.value;
                setLinkEditor((prev) => ({ ...prev, url: v }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLinkEditor();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeLinkEditor();
                }
              }}
              style={{ width: "240px" }}
            />
            <button className="find-replace-btn" onClick={applyLinkEditor}>
              Apply
            </button>
          </div>
        </>
      )}

      <div
        className="editor-container"
        ref={editorContainerRef}
        onScroll={(e) => rememberScroll(e.currentTarget.scrollTop)}
        style={{ ["--editor-zoom" as any]: zoom }}
      >
        <div className="editor-wrapper" data-content-theme={contentTheme}>
          {isMarkdown && editMode === "rich" ? (
            <div
              style={{ display: "contents" }}
              onContextMenu={(e) =>
                showContextMenu(e, [
                  ...textEditingMenuItems(e.target instanceof Element ? e.target : null),
                  ...tableMenuItems(editor),
                  ...fileMenuItems().map((item, index) =>
                    item && index === 0 ? { ...item, separatorBefore: true } : item,
                  ),
                ])
              }
            >
              <EditorContent editor={editor} />
            </div>
          ) : (
            <textarea
              className="plain-text-editor"
              ref={plainTextareaRef}
              value={plainContent}
              onScroll={(e) => rememberScroll(e.currentTarget.scrollTop)}
              onChange={(e) => {
                const val = e.target.value;
                setPlainContent(val);
                onChange?.(filePath, val);
              }}
              onClick={(e) => {
                if ((e.metaKey || e.ctrlKey) && onOpenFile) {
                  const target = e.target as HTMLTextAreaElement;
                  const text = target.value;
                  const pos = target.selectionStart;
                  const leftStr = text.substring(0, pos);
                  const rightStr = text.substring(pos);
                  const matchLeft = leftStr.match(/([^\s"'\(\)\[\]]+)$/);
                  const matchRight = rightStr.match(/^([^\s"'\(\)\[\]]+)/);
                  const word = (matchLeft ? matchLeft[1] : '') + (matchRight ? matchRight[1] : '');
                  if (word && (word.includes('.md') || word.includes('.txt') || word.includes('/'))) {
                    onOpenFile(resolvePath(filePath, word));
                  }
                }
              }}
              placeholder="Plain text editor..."
              style={{
                width: "100%",
                flexGrow: 1,
                height: "100%",
                border: "none",
                outline: "none",
                resize: "none",
                background: "transparent",
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono, 'Fira Code', 'JetBrains Mono', Courier, monospace)",
                fontSize: `${14 * zoom}px`,
                lineHeight: "1.6",
                whiteSpace: "pre-wrap",
                padding: "20px 28px",
                boxSizing: "border-box",
              }}
              autoFocus
            />
          )}
        </div>
      </div>
    </div>
  );
}
