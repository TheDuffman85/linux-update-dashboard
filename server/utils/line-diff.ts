type DiffOp = { type: " " | "-" | "+"; line: string };

// Above this many LCS cells the diff falls back to "remove all, add all".
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffOps(before: string[], after: string[]): DiffOp[] {
  // Trim the common prefix and suffix so the LCS table only covers the change.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const prefix = before.slice(0, start).map((line): DiffOp => ({ type: " ", line }));
  const suffix = before.slice(endBefore).map((line): DiffOp => ({ type: " ", line }));
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);

  let middle: DiffOp[];
  if (a.length * b.length > MAX_LCS_CELLS) {
    middle = [
      ...a.map((line): DiffOp => ({ type: "-", line })),
      ...b.map((line): DiffOp => ({ type: "+", line })),
    ];
  } else {
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] = a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        middle.push({ type: " ", line: a[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        middle.push({ type: "-", line: a[i++] });
      } else {
        middle.push({ type: "+", line: b[j++] });
      }
    }
    while (i < a.length) middle.push({ type: "-", line: a[i++] });
    while (j < b.length) middle.push({ type: "+", line: b[j++] });
  }
  return [...prefix, ...middle, ...suffix];
}

/** Unified diff of two texts with three lines of context; empty when equal. */
export function buildUnifiedDiff(path: string, before: string, after: string, context = 3): string {
  const ops = diffOps(splitLines(before), splitLines(after));
  const changed = ops.flatMap((op, index) => (op.type === " " ? [] : [index]));
  if (changed.length === 0) return "";

  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length, index + context + 1);
    const last = hunks.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }

  const output = [`--- ${path}`, `+++ ${path}`];
  for (const [from, to] of hunks) {
    let oldStart = 1;
    let newStart = 1;
    for (const op of ops.slice(0, from)) {
      if (op.type !== "+") oldStart++;
      if (op.type !== "-") newStart++;
    }
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((op) => op.type !== "+").length;
    const newCount = slice.filter((op) => op.type !== "-").length;
    output.push(`@@ -${oldCount ? oldStart : oldStart - 1},${oldCount} +${newCount ? newStart : newStart - 1},${newCount} @@`);
    output.push(...slice.map((op) => `${op.type}${op.line}`));
  }
  return output.join("\n");
}
