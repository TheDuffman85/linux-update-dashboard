import { Fragment, type ReactNode } from "react";
import type { RepositorySourceFormat } from "./systems";

// Reuses the highlight.js class names styled under `.script-code`.
const URL_TOKEN = /(\b[a-z][a-z0-9+.-]*:\/\/\S+|\bcdrom:\S+)/i;
const APT_LIST_LINE = /^(\s*)(deb(?:-src)?)(\s+)(\[[^\]]*\])?(.*)$/;
const DEB822_FIELD = /^([A-Za-z0-9-]+)(:)(.*)$/;
const INI_SECTION = /^(\s*)(\[[^\]]*\])(.*)$/;
const INI_ASSIGNMENT = /^(\s*)([^=\s][^=]*?)(\s*=)(.*)$/;
const APK_TAG = /^(\s*)(@\S+)(.*)$/;

function span(key: string, className: string, value: string): ReactNode {
  return <span key={key} className={className}>{value}</span>;
}

function highlightUrls(value: string, key: string): ReactNode[] {
  return value.split(URL_TOKEN).map((part, index) =>
    index % 2 === 1 ? span(`${key}-url-${index}`, "hljs-string", part) : part
  );
}

function highlightLine(line: string, format: RepositorySourceFormat, key: string): ReactNode[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#") || (format === "ini" && trimmed.startsWith(";"))) {
    return [span(`${key}-comment`, "hljs-comment", line)];
  }

  if (format === "apt-list") {
    const match = APT_LIST_LINE.exec(line);
    if (match) {
      const [, indent, type, gap, options = "", rest] = match;
      return [
        indent,
        span(`${key}-type`, "hljs-keyword", type),
        gap,
        ...(options ? [span(`${key}-options`, "hljs-attr", options)] : []),
        ...highlightUrls(rest, key),
      ];
    }
  }

  if (format === "deb822") {
    const match = DEB822_FIELD.exec(line);
    if (match) {
      const [, field, colon, value] = match;
      return [span(`${key}-field`, "hljs-attr", field), colon, ...highlightUrls(value, key)];
    }
  }

  if (format === "ini") {
    const section = INI_SECTION.exec(line);
    if (section) {
      const [, indent, name, rest] = section;
      return [indent, span(`${key}-section`, "hljs-title", name), rest];
    }
    const assignment = INI_ASSIGNMENT.exec(line);
    if (assignment) {
      const [, indent, name, equals, value] = assignment;
      return [indent, span(`${key}-key`, "hljs-attr", name), equals, ...highlightUrls(value, key)];
    }
  }

  if (format === "plain") {
    const tagged = APK_TAG.exec(line);
    if (tagged) {
      const [, indent, tag, rest] = tagged;
      return [indent, span(`${key}-tag`, "hljs-keyword", tag), ...highlightUrls(rest, key)];
    }
  }

  return highlightUrls(line, key);
}

export function highlightRepositorySource(content: string, format: RepositorySourceFormat): ReactNode {
  return content.split("\n").map((line, index, lines) => (
    <Fragment key={`line-${index}`}>
      {highlightLine(line, format, `line-${index}`)}
      {index < lines.length - 1 ? "\n" : null}
    </Fragment>
  ));
}
