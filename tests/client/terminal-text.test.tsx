import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TerminalOutput } from "../../client/components/TerminalOutput";
import { TerminalText, parseTerminalText } from "../../client/components/TerminalText";

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
