import type { ContextMenuEntry } from "../components/ContextMenu";

/**
 * Cut / copy / paste / select-all for whatever the user right-clicked, so the
 * app can suppress the webview's own menu without taking away the clipboard
 * actions people expect in a text field.
 */

type TextField = HTMLInputElement | HTMLTextAreaElement;

const isTextField = (el: Element | null): el is TextField =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

const isEditable = (el: Element | null) =>
  isTextField(el) || (el instanceof HTMLElement && el.isContentEditable);

/** The text currently selected inside `el` (or in the page, outside a field). */
function selectedText(el: Element | null): string {
  if (isTextField(el)) {
    const { selectionStart, selectionEnd, value } = el;
    if (selectionStart == null || selectionEnd == null) return "";
    return value.slice(selectionStart, selectionEnd);
  }
  return window.getSelection()?.toString() ?? "";
}

/**
 * Replace the selection in a React-controlled field. Setting `.value` directly
 * would leave React's internal value tracker thinking nothing changed, so the
 * component's `onChange` would never run — hence the native setter plus a
 * synthetic `input` event.
 */
function replaceSelection(el: TextField, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, "value")?.set;
  setter?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
}

async function paste(el: Element | null) {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return; // clipboard read denied — nothing sensible left to do
  }
  if (!text) return;
  if (isTextField(el)) {
    el.focus();
    replaceSelection(el, text);
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    el.focus();
    // ProseMirror handles `insertText` like typed input, so this lands as a
    // normal, undoable edit.
    document.execCommand("insertText", false, text);
  }
}

/**
 * The standard clipboard entries for `target`. Returns an empty list when
 * there is nothing to act on (not editable, nothing selected), so the caller
 * can simply suppress the menu instead of showing a dead one.
 */
export function textEditingMenuItems(target: Element | null): ContextMenuEntry[] {
  const editable = isEditable(target);
  const selection = selectedText(target);
  if (!editable && !selection) return [];

  return [
    editable && {
      label: "Cut",
      disabled: !selection,
      onSelect: () => {
        void navigator.clipboard.writeText(selection);
        if (isTextField(target)) replaceSelection(target, "");
        else document.execCommand("delete");
      },
    },
    {
      label: "Copy",
      disabled: !selection,
      onSelect: () => {
        void navigator.clipboard.writeText(selection);
      },
    },
    editable && {
      label: "Paste",
      onSelect: () => {
        void paste(target);
      },
    },
    editable && {
      label: "Select all",
      separatorBefore: true,
      onSelect: () => {
        if (isTextField(target)) {
          target.focus();
          target.select();
        } else if (target instanceof HTMLElement) {
          target.focus();
          document.execCommand("selectAll");
        }
      },
    },
  ];
}
