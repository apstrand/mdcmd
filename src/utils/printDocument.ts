import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

/** The reading themes offered in the editor; the print layout mirrors them. */
export type ContentTheme = "default" | "reading" | "clarity";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
}).use(taskLists);

const ROOT_ID = "mdcmd-print-root";
const STYLE_ID = "mdcmd-print-style";

/** Per-theme page geometry and body type, matching the in-app reading themes. */
const THEMES: Record<ContentTheme, { maxWidth: string; bodyFont: string; lineHeight: string }> = {
  default: {
    maxWidth: "46rem",
    bodyFont: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
    lineHeight: "1.55",
  },
  reading: {
    maxWidth: "40rem",
    bodyFont: `Georgia, "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif`,
    lineHeight: "1.75",
  },
  clarity: {
    maxWidth: "52rem",
    bodyFont: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`,
    lineHeight: "1.5",
  },
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The print-only stylesheet. It runs on the top-level document (see
 * `printDocument` for why), so it must both hide the live app and re-style the
 * injected page from scratch — the app's own dark-theme rules would otherwise
 * bleed through. Tuned for paper: a light background, comfortable margins, and
 * page-break rules so headings aren't stranded and code blocks / tables aren't
 * sliced across pages. Every content rule is scoped to `#${ROOT_ID}`.
 */
function printStyles(theme: ContentTheme): string {
  const t = THEMES[theme];
  const r = `#${ROOT_ID}`;
  return `
  @page { margin: 20mm 18mm; }

  /* Hide everything in the live app; show only the print page. */
  body > *:not(${r}) { display: none !important; }
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
  ${r} { display: block !important; color: #1a1a1a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  ${r} .mdcmd-print-page {
    max-width: ${t.maxWidth}; margin: 0 auto;
    font-family: ${t.bodyFont}; line-height: ${t.lineHeight}; font-size: 11.5pt;
  }
  ${r} h1, ${r} h2, ${r} h3, ${r} h4, ${r} h5, ${r} h6 {
    line-height: 1.25; font-weight: 700; break-after: avoid; page-break-after: avoid; color: #1a1a1a;
  }
  ${r} h1 { font-size: 2em; margin: 0 0 0.6em; padding-bottom: 0.3em; border-bottom: 1px solid #e2e2e2; }
  ${r} h2 { font-size: 1.5em; margin: 1.4em 0 0.5em; }
  ${r} h3 { font-size: 1.25em; margin: 1.3em 0 0.4em; }
  ${r} h4, ${r} h5, ${r} h6 { font-size: 1.05em; margin: 1.2em 0 0.4em; }
  ${r} p { margin: 0 0 1em; orphans: 3; widows: 3; }
  ${r} a { color: #0b61c4; text-decoration: none; }
  ${r} ul, ${r} ol { padding-left: 1.6em; margin: 0 0 1em; }
  ${r} li { margin-bottom: 0.3em; }
  ${r} li > p { margin: 0; }
  ${r} ul.contains-task-list { list-style: none; padding-left: 0.2em; }
  ${r} li.task-list-item { display: flex; align-items: flex-start; gap: 0.5em; }
  ${r} input.task-list-item-checkbox { margin-top: 0.35em; }
  ${r} blockquote {
    margin: 0 0 1em; padding: 0.2em 1em; border-left: 4px solid #d0d7de;
    color: #57606a; break-inside: avoid;
  }
  ${r} code {
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    font-size: 0.88em; background: #f3f4f6; padding: 0.15em 0.4em; border-radius: 4px; color: #1a1a1a;
  }
  ${r} pre {
    background: #f6f8fa; border: 1px solid #e2e2e2; border-radius: 6px;
    padding: 12px 14px; overflow: visible; margin: 0 0 1em;
    break-inside: avoid; page-break-inside: avoid; white-space: pre-wrap; word-wrap: break-word;
  }
  ${r} pre code { background: none; padding: 0; font-size: 0.85em; }
  ${r} hr { border: 0; border-top: 1px solid #e2e2e2; margin: 2em 0; }
  ${r} img { max-width: 100%; }
  ${r} table {
    border-collapse: collapse; width: 100%; margin: 0 0 1em;
    break-inside: avoid; page-break-inside: avoid; font-size: 0.95em;
  }
  ${r} th, ${r} td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; vertical-align: top; }
  ${r} th { background: #f3f4f6; font-weight: 600; }
  ${r} tr:nth-child(even) td { background: #fafbfc; }
  `;
}

/**
 * Lay `content` out as a clean, light-themed page and open the OS print dialog,
 * whose "Save as PDF" is the export path and whose printer list is the print
 * path — so this one entry point serves both "export" and "print".
 *
 * It prints the *top-level* document, not an iframe. The rendered page is
 * injected into the live DOM and a print-only stylesheet (`@media print`) hides
 * the app and shows only that page. In Tauri's macOS WKWebView the JS
 * `window.print()` is a silent no-op, so the dialog is opened through the
 * native `print_webview` command (wry's `printOperationWithPrintInfo:`); the
 * browser build falls back to `window.print()`. Everything is torn down once
 * the dialog closes (or after a fallback delay, since the native path emits no
 * `afterprint`).
 *
 * @param content   the document's text (markdown source, or plain text)
 * @param fileName  sets `document.title` during printing, which becomes the
 *                  default PDF file name
 * @param asMarkdown whether to render `content` as markdown (false → preformatted)
 * @param theme     reading theme to mirror from the editor
 */
export function printDocument(
  content: string,
  fileName: string,
  asMarkdown: boolean,
  theme: ContentTheme = "default",
): void {
  const title = fileName.replace(/\.[^.]+$/, "") || fileName;
  const bodyHtml = asMarkdown
    ? md.render(content)
    : `<pre>${escapeHtml(content)}</pre>`;

  // Clear any leftovers from an interrupted previous run.
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.media = "print";
  style.textContent = printStyles(theme);

  const root = document.createElement("div");
  root.id = ROOT_ID;
  // Keep it out of the on-screen layout; the print stylesheet forces it visible
  // (with !important) only while printing.
  root.style.display = "none";
  root.innerHTML = `<div class="mdcmd-print-page">${bodyHtml}</div>`;

  const prevTitle = document.title;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    style.remove();
    root.remove();
    document.title = prevTitle;
    window.removeEventListener("afterprint", cleanup);
  };

  document.head.appendChild(style);
  document.body.appendChild(root);
  document.title = title;

  window.addEventListener("afterprint", cleanup);
  // Fallback: some webviews don't fire afterprint. Tidy up regardless.
  setTimeout(cleanup, 60000);

  // Let the webview apply the injected styles before the panel snapshots them.
  requestAnimationFrame(() => {
    void triggerPrint().catch(cleanup);
  });
}

/**
 * Open the print dialog by the route that actually works for the current
 * runtime: the native Tauri command on desktop (WKWebView ignores JS print),
 * `window.print()` everywhere else (and as a fallback if the command is absent,
 * e.g. mobile Tauri).
 */
async function triggerPrint(): Promise<void> {
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("print_webview");
      return;
    } catch {
      // Fall through to the web path (mobile Tauri has no such command).
    }
  }
  window.print();
}
