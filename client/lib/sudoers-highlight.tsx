import { Fragment, type ReactNode } from "react";

const TAG_PATTERN = /^(?:NO)?(?:PASSWD|EXEC|SETENV|LOG_INPUT|LOG_OUTPUT):$/;

function sudoersSpan(key: string, className: string, value: string): ReactNode {
  return <span key={key} className={className}>{value}</span>;
}

function splitRuleToken(token: string, index: number): ReactNode {
  const hostRunasMatch = token.match(/^(ALL)(=.+)$/);
  if (hostRunasMatch) {
    return (
      <Fragment key={`prefix-host-runas-${index}`}>
        {sudoersSpan(`prefix-host-${index}`, "sudoers-keyword", hostRunasMatch[1])}
        {sudoersSpan(`prefix-runas-${index}`, "sudoers-runas", hostRunasMatch[2])}
      </Fragment>
    );
  }

  if (token === "ALL") {
    return sudoersSpan(`prefix-host-${index}`, "sudoers-keyword", token);
  }
  if (/^\(.+\)$/.test(token) || /^=\(.+\)$/.test(token)) {
    return sudoersSpan(`prefix-runas-${index}`, "sudoers-runas", token);
  }
  if (TAG_PATTERN.test(token)) {
    return sudoersSpan(`prefix-tag-${index}`, "sudoers-tag", token);
  }

  return token;
}

function splitRulePrefix(value: string): ReactNode[] {
  const tokens = value.split(/(\s+)/);
  let meaningfulIndex = 0;

  return tokens.map((token, index) => {
    if (/^\s+$/.test(token) || token.length === 0) return token;

    meaningfulIndex += 1;
    if (meaningfulIndex === 1) {
      return sudoersSpan(`prefix-user-${index}`, "sudoers-user", token);
    }
    return splitRuleToken(token, index);
  });
}

function splitCommand(value: string, keyPrefix: string): ReactNode[] {
  return value.split(/(\s+)/).map((token, index) => {
    if (/^\s+$/.test(token) || token.length === 0) return token;

    if (token.includes("REPLACE_WITH_ABSOLUTE_PATH")) {
      return sudoersSpan(`${keyPrefix}-placeholder-${index}`, "sudoers-placeholder", token);
    }
    if (/^\/[^\s,]+/.test(token)) {
      return sudoersSpan(`${keyPrefix}-path-${index}`, "sudoers-path", token);
    }
    if (/\\[:=,\\]/.test(token)) {
      return sudoersSpan(`${keyPrefix}-escaped-${index}`, "sudoers-escaped", token);
    }
    if (token === '""' || token === "*") {
      return sudoersSpan(`${keyPrefix}-literal-${index}`, "sudoers-literal", token);
    }

    return token;
  });
}

function highlightRuleLine(line: string, lineIndex: number): ReactNode[] {
  const commandIndex = line.search(/:\s+(?=(?:\/|REPLACE_WITH_ABSOLUTE_PATH))/);
  if (commandIndex === -1) {
    if (line.includes("REPLACE_WITH_ABSOLUTE_PATH") || /^\/[^\s,]+/.test(line)) {
      return splitCommand(line, `line-${lineIndex}`);
    }

    return splitRulePrefix(line);
  }

  const prefix = line.slice(0, commandIndex + 1);
  const spacing = line.slice(commandIndex + 1).match(/^\s*/)?.[0] ?? "";
  const command = line.slice(commandIndex + 1 + spacing.length);

  return [
    ...splitRulePrefix(prefix),
    spacing,
    ...splitCommand(command, `line-${lineIndex}`),
  ];
}

function highlightSudoersLine(line: string, lineIndex: number): ReactNode {
  if (/^\s*#/.test(line)) {
    return sudoersSpan(`line-${lineIndex}-comment`, "hljs-comment", line);
  }

  const defaultsMatch = line.match(/^(\s*)(Defaults(?::[^\s]+)?)(\s*)(.*)$/);
  if (defaultsMatch) {
    const [, indent, directive, spacing, value] = defaultsMatch;
    return (
      <>
        {indent}
        {sudoersSpan(`line-${lineIndex}-defaults`, "sudoers-directive", directive)}
        {spacing}
        {splitCommand(value, `line-${lineIndex}-defaults`)}
      </>
    );
  }

  return <>{highlightRuleLine(line, lineIndex)}</>;
}

export function highlightSudoers(value: string): ReactNode[] {
  const lines = value.split("\n");
  return lines.map((line, index) => (
    <Fragment key={`sudoers-line-${index}`}>
      {highlightSudoersLine(line, index)}
      {index < lines.length - 1 ? "\n" : null}
    </Fragment>
  ));
}
