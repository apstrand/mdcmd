import { getHTMLFromFragment, type Editor } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { ContextMenuEntry } from "../components/ContextMenu";

/**
 * GFM pipe tables for the rich editor.
 *
 * markdown-it (inside tiptap-markdown) already parses pipe tables; these nodes
 * give the parsed tables somewhere to live in the schema. The serializer is our
 * own rather than tiptap-markdown's built-in one, which drops column alignment
 * (`:---:` comes back as `---`) and doesn't escape `|` inside cells — and since
 * any edit re-serializes the whole file, that would silently damage every table
 * in a document the moment you touched an unrelated paragraph.
 */

type Align = "left" | "center" | "right" | null;

/** Column alignment, as markdown-it emits it: `style="text-align:center"`. */
const alignAttribute = {
  align: {
    default: null as Align,
    parseHTML: (element: HTMLElement): Align => {
      const value = element.style.textAlign || element.getAttribute("align");
      return value === "left" || value === "center" || value === "right" ? value : null;
    },
    renderHTML: (attributes: { align: Align }) =>
      attributes.align ? { style: `text-align: ${attributes.align}` } : {},
  },
};

const AlignedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute };
  },
});

const AlignedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignAttribute };
  },
});

const children = (node: PMNode) => {
  const list: PMNode[] = [];
  node.forEach((child) => list.push(child));
  return list;
};

/**
 * Whether a table fits pipe-table syntax: a header row of header cells, body
 * rows of plain cells, no merged cells, and one paragraph per cell. Anything
 * else (say, a table pasted from a web page) is written out as HTML instead.
 */
function isPipeTable(table: PMNode) {
  const [head, ...body] = children(table);
  if (!head) return false;
  const simple = (cell: PMNode) =>
    cell.attrs.colspan <= 1 &&
    cell.attrs.rowspan <= 1 &&
    cell.childCount === 1 &&
    cell.firstChild!.type.name === "paragraph";
  return (
    children(head).every((cell) => cell.type.name === "tableHeader" && simple(cell)) &&
    body.every((row) =>
      children(row).every((cell) => cell.type.name === "tableCell" && simple(cell)),
    ) &&
    body.every((row) => row.childCount === head.childCount)
  );
}

/** Escape every `|` not already escaped, so it can't end the cell early. */
const escapePipes = (text: string) =>
  text.replace(/(\\*)\|/g, (match, slashes: string) =>
    slashes.length % 2 ? match : `${slashes}\\|`,
  );

/** Column width as the eye sees it in a monospace editor (code points, not UTF-16 units). */
const width = (text: string) => [...text].length;

function delimiter(align: Align, size: number) {
  switch (align) {
    case "left":
      return `:${"-".repeat(size - 1)}`;
    case "center":
      return `:${"-".repeat(size - 2)}:`;
    case "right":
      return `${"-".repeat(size - 1)}:`;
    default:
      return "-".repeat(size);
  }
}

function pad(text: string, size: number, align: Align) {
  const space = size - width(text);
  if (align === "right") return " ".repeat(space) + text;
  if (align === "center") {
    const left = Math.floor(space / 2);
    return " ".repeat(left) + text + " ".repeat(space - left);
  }
  return text + " ".repeat(space);
}

// prosemirror-markdown's serializer state; tiptap-markdown doesn't export a type for it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SerializerState = any;

function serializeTable(this: { editor: Editor }, state: SerializerState, node: PMNode) {
  if (!isPipeTable(node)) {
    state.write(getHTMLFromFragment(Fragment.from(node), node.type.schema));
    state.closeBlock(node);
    return;
  }

  // Render each cell's inline content on a scratch state so the columns can be
  // measured and padded before anything is written.
  const renderCell = (cell: PMNode) => {
    const scratch = new state.constructor(state.nodes, state.marks, state.options);
    scratch.inTable = true; // hard breaks become <br>, which a pipe table can hold
    scratch.renderInline(cell.firstChild);
    return escapePipes(scratch.out.trim());
  };

  const rows = children(node).map((row) => children(row).map(renderCell));
  const aligns = children(node.firstChild!).map((cell) => cell.attrs.align as Align);
  const sizes = aligns.map((align, column) =>
    Math.max(align === "center" ? 5 : 3, ...rows.map((row) => width(row[column]))),
  );

  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const lines = rows.map((row) =>
    line(row.map((text, column) => pad(text, sizes[column], aligns[column]))),
  );
  lines.splice(1, 0, line(aligns.map((align, column) => delimiter(align, sizes[column]))));
  // ensureNewLine between rows only: one after the last row would leave a
  // stray blank line when the table ends the document.
  lines.forEach((text, index) => {
    if (index) state.ensureNewLine();
    state.write(text);
  });
  state.closeBlock(node);
}

const MarkdownTable = Table.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: serializeTable,
        parse: {
          // handled by markdown-it
        },
      },
    };
  },
});

export const tableExtensions = [
  MarkdownTable.configure({ resizable: false }),
  TableRow,
  AlignedTableHeader,
  AlignedTableCell,
];

/** Set the alignment of the column(s) under the selection, header included. */
function alignColumn(editor: Editor, align: Align) {
  // GFM alignment belongs to the whole column, not one cell, so set it on the
  // caret's column in every row.
  const { state } = editor;
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const cellNode = $from.node(depth);
    if (cellNode.type.name !== "tableCell" && cellNode.type.name !== "tableHeader") continue;
    const table = $from.node(depth - 2);
    const tableStart = $from.start(depth - 2);
    const column = $from.index(depth - 1);
    const tr = state.tr;
    table.forEach((row, rowOffset) => {
      let cellOffset = 0;
      row.forEach((_cell, offset, index) => {
        if (index === column) cellOffset = offset;
      });
      const pos = tableStart + rowOffset + 1 + cellOffset;
      const cell = tr.doc.nodeAt(pos);
      if (cell && cell.attrs.align !== align) {
        tr.setNodeMarkup(pos, undefined, { ...cell.attrs, align });
      }
    });
    if (tr.docChanged) editor.view.dispatch(tr);
    editor.commands.focus();
    return;
  }
}

/** Right-click entries: insert a table outside one, edit rows/columns inside. */
export function tableMenuItems(editor: Editor | null): ContextMenuEntry[] {
  if (!editor || !editor.isEditable) return [];
  const run = (command: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) =>
    () => command(editor.chain().focus()).run();

  if (!editor.isActive("table")) {
    return [
      {
        label: "Insert table",
        separatorBefore: true,
        onSelect: run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })),
      },
    ];
  }

  const inHeader = editor.isActive("tableHeader");
  return [
    {
      label: "Insert row above",
      separatorBefore: true,
      disabled: inHeader, // a pipe table's header must stay its first row
      onSelect: run((c) => c.addRowBefore()),
    },
    { label: "Insert row below", onSelect: run((c) => c.addRowAfter()) },
    { label: "Insert column left", onSelect: run((c) => c.addColumnBefore()) },
    { label: "Insert column right", onSelect: run((c) => c.addColumnAfter()) },
    {
      label: "Delete row",
      disabled: inHeader,
      onSelect: run((c) => c.deleteRow()),
    },
    { label: "Delete column", onSelect: run((c) => c.deleteColumn()) },
    { label: "Align column left", separatorBefore: true, onSelect: () => alignColumn(editor, "left") },
    { label: "Align column center", onSelect: () => alignColumn(editor, "center") },
    { label: "Align column right", onSelect: () => alignColumn(editor, "right") },
    { label: "Clear column alignment", onSelect: () => alignColumn(editor, null) },
    { label: "Delete table", separatorBefore: true, onSelect: run((c) => c.deleteTable()) },
  ];
}
