type TerminalStream = "stdout" | "stderr";

interface AnsiState {
  classes: string[];
  hasColor: boolean;
}

interface TerminalChunk {
  text: string;
  classes: string[];
  hasColor: boolean;
}

const ANSI_PATTERN = /\x1b\[([0-9;]*)?([A-Za-z])/g;

const ANSI_COLOR_CLASSES: Record<number, string> = {
  30: "text-slate-700",
  31: "text-red-400",
  32: "text-green-400",
  33: "text-amber-300",
  34: "text-blue-400",
  35: "text-fuchsia-400",
  36: "text-cyan-300",
  37: "text-slate-200",
  90: "text-slate-500",
  91: "text-red-300",
  92: "text-green-300",
  93: "text-yellow-200",
  94: "text-blue-300",
  95: "text-fuchsia-300",
  96: "text-cyan-200",
  97: "text-white",
};

const STYLE_CLASSES: Record<number, string> = {
  1: "font-semibold",
  2: "opacity-70",
  3: "italic",
  4: "underline underline-offset-2",
};

function removeMatchingClass(classes: string[], predicate: (className: string) => boolean): string[] {
  return classes.filter((className) => !predicate(className));
}

function addClass(classes: string[], className: string): string[] {
  return classes.includes(className) ? classes : [...classes, className];
}

function applyAnsiCodes(state: AnsiState, codes: number[]): AnsiState {
  let classes = [...state.classes];
  let hasColor = state.hasColor;

  for (const code of codes.length ? codes : [0]) {
    if (code === 0) {
      classes = [];
      hasColor = false;
    } else if (code === 22) {
      classes = removeMatchingClass(classes, (className) => className === "font-semibold" || className === "opacity-70");
    } else if (code === 23) {
      classes = removeMatchingClass(classes, (className) => className === "italic");
    } else if (code === 24) {
      classes = removeMatchingClass(classes, (className) => className.startsWith("underline"));
    } else if (code === 39) {
      classes = removeMatchingClass(classes, (className) => className.startsWith("text-"));
      hasColor = false;
    } else if (STYLE_CLASSES[code]) {
      classes = addClass(classes, STYLE_CLASSES[code]);
    } else if (ANSI_COLOR_CLASSES[code]) {
      classes = removeMatchingClass(classes, (className) => className.startsWith("text-"));
      classes = addClass(classes, ANSI_COLOR_CLASSES[code]);
      hasColor = true;
    }
  }

  return { classes, hasColor };
}

export function parseTerminalText(text: string): TerminalChunk[] {
  const chunks: TerminalChunk[] = [];
  const state: AnsiState = { classes: [], hasColor: false };
  let current = state;
  let lastIndex = 0;

  for (const match of text.matchAll(ANSI_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      chunks.push({
        text: text.slice(lastIndex, index),
        classes: current.classes,
        hasColor: current.hasColor,
      });
    }

    if (match[2] === "m") {
      const codes = (match[1] || "")
        .split(";")
        .filter(Boolean)
        .map((part) => Number.parseInt(part, 10))
        .filter((code) => Number.isInteger(code));
      current = applyAnsiCodes(current, codes);
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    chunks.push({
      text: text.slice(lastIndex),
      classes: current.classes,
      hasColor: current.hasColor,
    });
  }

  return chunks;
}

export function TerminalText({
  text,
  stream = "stdout",
}: {
  text: string;
  stream?: TerminalStream;
}) {
  const fallbackClass = stream === "stderr" ? "text-red-400" : "";
  const chunks = parseTerminalText(text);

  return (
    <>
      {chunks.map((chunk, index) => {
        const classes = chunk.classes.length ? chunk.classes : fallbackClass ? [fallbackClass] : [];
        return (
          <span key={index} className={classes.join(" ") || undefined}>
            {chunk.text}
          </span>
        );
      })}
    </>
  );
}
