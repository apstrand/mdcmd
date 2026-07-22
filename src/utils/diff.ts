// Minimal line-based diff (LCS) used to preview a modified file's changes in
// the "unsaved changes" dialog. Kept dependency-free and small: notes/markdown
// files are well within the O(n*m) budget, and a guard falls back to a plain
// remove-then-add rendering for pathologically large inputs.

export type DiffLineType = "add" | "del" | "same";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

// Above this many cells the LCS table gets expensive; fall back to a naive diff.
const MAX_CELLS = 4_000_000;

export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  if (oldText === newText) {
    return oldText === "" ? [] : oldText.split("\n").map((text) => ({ type: "same", text }));
  }

  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  }

  // dp[i][j] = length of the LCS of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "del", text: a[i] });
      i++;
    } else {
      result.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) result.push({ type: "del", text: a[i++] });
  while (j < m) result.push({ type: "add", text: b[j++] });
  return result;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { added, removed };
}
