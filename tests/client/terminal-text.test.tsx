import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ContentExpansionButton, isContentOverflowing } from "../../client/components/CopyableCodeBlock";
import { TerminalOutput } from "../../client/components/TerminalOutput";
import { TerminalText, parseTerminalText } from "../../client/components/TerminalText";

describe("content expansion", () => {
  test("detects content taller than its capped container", () => {
    expect(isContentOverflowing({ scrollHeight: 256, clientHeight: 256 })).toBe(false);
    expect(isContentOverflowing({ scrollHeight: 257, clientHeight: 256 })).toBe(true);
  });

  test("labels the control for expanding and collapsing content", () => {
    const collapsed = renderToStaticMarkup(
      <ContentExpansionButton expanded={false} onToggle={() => undefined} />
    );
    const expanded = renderToStaticMarkup(
      <ContentExpansionButton expanded={true} onToggle={() => undefined} />
    );

    expect(collapsed).toContain('aria-label="Show all content"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(expanded).toContain('aria-label="Collapse content"');
    expect(expanded).toContain('aria-expanded="true"');
  });
});

describe("TerminalText", () => {
  test("renders ANSI colors without exposing escape sequences", () => {
    const html = renderToStaticMarkup(
      <TerminalText text={"\x1b[31mFailed\x1b[0m\n"} />
    );

    expect(html).toContain("text-red-400");
    expect(html).toContain("Failed");
    expect(html).not.toContain("[31m");
  });

  test("does not color plain package-manager words", () => {
    const html = renderToStaticMarkup(
      <TerminalText text={"34 upgraded, 0 newly installed, 0 to remove\n"} />
    );

    expect(html).toContain("34 upgraded");
    expect(html).not.toContain("text-green-400");
    expect(html).not.toContain("font-semibold");
  });

  test("colors stderr output as an error stream", () => {
    const html = renderToStaticMarkup(
      <TerminalText text={"warning: package kept back\n"} stream="stderr" />
    );

    expect(html).toContain("text-red-400");
  });

  test("parses ANSI chunks for live output rendering", () => {
    expect(parseTerminalText("ok \x1b[32mdone\x1b[0m")[1]).toMatchObject({
      text: "done",
      classes: ["text-green-400"],
      hasColor: true,
    });
  });
});

describe("TerminalOutput", () => {
  test("renders live output through terminal text styling", () => {
    const html = renderToStaticMarkup(
      <TerminalOutput
        messages={[
          {
            type: "output",
            data: "\x1b[33mwarning\x1b[0m: reboot required\n",
            stream: "stdout",
          },
        ]}
        isActive={true}
        phase={null}
        connected={true}
      />
    );

    expect(html).toContain("text-amber-300");
    expect(html).toContain("warning");
    expect(html).not.toContain("[33m");
  });
});
