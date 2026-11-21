import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * The app's own right-click menus, replacing the webview's default one (which
 * offers browser actions — reload, inspect — that mean nothing here).
 *
 * Menus are opened imperatively with `showContextMenu` from wherever the
 * right-click happened, so no component has to thread menu state through its
 * props; `<ContextMenuHost />`, mounted once at the app root, renders them.
 */
export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
}

/** Entries may be conditional; anything falsy is dropped. */
export type ContextMenuEntry = ContextMenuItem | false | null | undefined;

interface MenuRequest {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

type Subscriber = (request: MenuRequest | null) => void;

let subscriber: Subscriber | null = null;

interface PositionedEvent {
  clientX: number;
  clientY: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Open a menu at the event's position. Call this from an `onContextMenu`
 * handler: it marks the event handled, which is what stops the app-level
 * fallback menu (and the webview's own) from also appearing.
 */
export function showContextMenu(event: PositionedEvent, entries: ContextMenuEntry[]) {
  const items = entries.filter(Boolean) as ContextMenuItem[];
  event.preventDefault();
  event.stopPropagation();
  if (items.length === 0) return;
  subscriber?.({ x: event.clientX, y: event.clientY, items });
}

export function closeContextMenu() {
  subscriber?.(null);
}

export function ContextMenuHost() {
  const [request, setRequest] = useState<MenuRequest | null>(null);
  // Where the menu ends up once measured. Kept in state rather than written
  // straight to the node's style, which any re-render of this component would
  // overwrite with the unmeasured position (leaving the menu hidden).
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    subscriber = setRequest;
    return () => {
      subscriber = null;
    };
  }, []);

  // Keep the menu inside the window: measure it, then nudge it back from the
  // right/bottom edges (a right-click near a corner would otherwise open a
  // menu that runs off screen). It renders hidden for that one frame.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!request || !el) {
      setPosition(null);
      return;
    }
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    setPosition({
      x: Math.max(4, Math.min(request.x, innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(request.y, innerHeight - rect.height - 4)),
    });
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const close = () => setRequest(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // `click` closes after a selection has been handled; `contextmenu`
    // elsewhere closes before the next menu opens.
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [request]);

  if (!request) return null;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: position?.x ?? request.x,
        top: position?.y ?? request.y,
        visibility: position ? "visible" : "hidden",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {request.items.map((item, index) => (
        <button
          key={`${item.label}-${index}`}
          className={`context-menu-item${item.separatorBefore ? " with-separator" : ""}`}
          disabled={item.disabled}
          onClick={() => {
            setRequest(null);
            item.onSelect();
          }}
        >
          {item.icon && <span className="context-menu-icon">{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
