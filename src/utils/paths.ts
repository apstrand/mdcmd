export interface PathRoot {
  path: string;
  isDir: boolean;
}

/**
 * Strip a leading slash/backslash. Needed before rendering a path inside an
 * element that uses the `direction: rtl; text-align: left` trick to
 * left-truncate long paths — without this, a leading separator gets
 * bidi-relocated to the visual end of the text and reads as a bogus
 * trailing slash.
 */
export function rtlTruncate(path: string): string {
  return path.replace(/^[/\\]+/, "");
}

function lastComponent(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Render `fullPath` relative to its containing pinned "storage root" (a folder
 * picked from Files / iCloud Drive), e.g. "Notes › drafts › todo.md", instead
 * of the raw device path (/private/var/mobile/…). Falls back to the absolute
 * path when it isn't under any pinned root.
 */
export function displayRelativePath(fullPath: string, roots: PathRoot[]): string {
  if (!fullPath) return fullPath;
  const sep = fullPath.includes("\\") ? "\\" : "/";
  const root = roots
    .filter(
      (p) =>
        p.isDir &&
        (fullPath === p.path ||
          fullPath.startsWith(p.path.replace(/[/\\]+$/, "") + sep)),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!root) return fullPath;
  const rootName = lastComponent(root.path);
  const sub = fullPath.substring(root.path.length).replace(/^[/\\]+/, "");
  return sub ? `${rootName} › ${sub}` : rootName;
}
