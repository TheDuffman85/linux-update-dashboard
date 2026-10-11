import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightRepositorySource } from "../../client/lib/repository-source-highlight";
import type { RepositorySourceFile } from "../../client/lib/systems";

const { mockUseRepositorySources } = vi.hoisted(() => ({
  mockUseRepositorySources: vi.fn(),
}));

vi.mock("../../client/lib/systems", () => ({
  useRepositorySources: mockUseRepositorySources,
  useSaveRepositorySource: () => ({ mutate: vi.fn(), isPending: false }),
}));

function sourceFile(overrides: Partial<RepositorySourceFile> = {}): RepositorySourceFile {
  return {
    path: "/etc/apt/sources.list.d/debian.sources",
    format: "deb822",
    pkgManagers: ["apt"],
    readable: true,
    content: "Types: deb\n",
    truncated: false,
    redacted: false,
    sha256: "abc",
    editable: true,
    editBlockedReason: null,
    ...overrides,
  };
}

function mockSources(files: RepositorySourceFile[], editingEnabled = true) {
  mockUseRepositorySources.mockReturnValue({
    data: { pkgManagers: ["apt"], unsupportedPkgManagers: [], editingEnabled, fetchedAt: "2026-10-11T12:00:00.000Z", files },
    isFetching: false,
    isError: false,
  });
}

import { RepositorySourcesPanel } from "../../client/components/systems/RepositorySourcesPanel";

function render(content: string, format: Parameters<typeof highlightRepositorySource>[1]) {
  return renderToStaticMarkup(<code>{highlightRepositorySource(content, format)}</code>);
}

describe("repository source highlighting", () => {
  test("highlights one-line APT entries", () => {
    const html = render(
      "# comment\ndeb [arch=amd64 signed-by=/k.gpg] https://example.com/debian bookworm main",
      "apt-list",
    );

    expect(html).toContain('<span class="hljs-comment"># comment</span>');
    expect(html).toContain('<span class="hljs-keyword">deb</span>');
    expect(html).toContain('<span class="hljs-attr">[arch=amd64 signed-by=/k.gpg]</span>');
    expect(html).toContain('<span class="hljs-string">https://example.com/debian</span> bookworm main');
  });

  test("highlights deb822 fields and INI sections", () => {
    expect(render("URIs: http://deb.debian.org/debian", "deb822"))
      .toContain('<span class="hljs-attr">URIs</span>: <span class="hljs-string">http://deb.debian.org/debian</span>');
    const ini = render("[fedora]\nbaseurl=https://example.com/$releasever\n; note", "ini");
    expect(ini).toContain('<span class="hljs-title">[fedora]</span>');
    expect(ini).toContain('<span class="hljs-attr">baseurl</span>=');
    expect(ini).toContain('<span class="hljs-comment">; note</span>');
  });

  test("keeps the original text", () => {
    const content = "@edge https://dl-cdn.alpinelinux.org/alpine/edge/main\n\nplain line";
    const html = render(content, "plain");
    expect(html.replace(/<[^>]+>/g, "")).toBe(content);
  });
});

describe("repository sources panel", () => {
  test("reads the host's sources for the selected system", () => {
    mockUseRepositorySources.mockReturnValue({ data: undefined, isFetching: true, isError: false });

    const html = renderToStaticMarkup(<RepositorySourcesPanel systemId={7} />);

    expect(html).toContain("spinner");
    expect(mockUseRepositorySources).toHaveBeenCalledWith(7);
  });

  test("renders files, badges, and unsupported managers", () => {
    mockUseRepositorySources.mockReturnValue({
      data: {
        pkgManagers: ["apt"],
        unsupportedPkgManagers: ["snap"],
        editingEnabled: false,
        fetchedAt: "2026-10-11T12:00:00.000Z",
        files: [
          {
            path: "/etc/apt/sources.list.d/private.list",
            format: "apt-list",
            pkgManagers: ["apt"],
            readable: true,
            content: "deb https://***@apt.example.com/ stable main\n",
            truncated: false,
            redacted: true,
            sha256: null,
            editable: false,
            editBlockedReason: "disabled",
          },
          {
            path: "/etc/apt/sources.list.d/locked.list",
            format: "apt-list",
            pkgManagers: ["apt"],
            readable: false,
            content: null,
            truncated: false,
            redacted: false,
            sha256: null,
            editable: false,
            editBlockedReason: "unreadable",
          },
        ],
      },
      isFetching: false,
      isError: false,
    });

    const html = renderToStaticMarkup(<RepositorySourcesPanel systemId={7} />);

    expect(html).toContain("/etc/apt/sources.list.d/private.list");
    expect(html).toContain("Credentials masked");
    expect(html).toContain("https://***@apt.example.com/");
    expect(html).toContain("The SSH user cannot read this file.");
    expect(html).toContain("Not shown: snap (no repository source files).");
  });

  test("shows the read error", () => {
    mockUseRepositorySources.mockReturnValue({
      data: undefined,
      isFetching: false,
      isError: true,
      error: new Error("Host is offline"),
    });

    const html = renderToStaticMarkup(<RepositorySourcesPanel systemId={7} />);

    expect(html).toContain("Unable to read repository sources: Host is offline");
  });

  test("offers editing only for editable files and non-read-only users", () => {
    mockSources([sourceFile()]);

    expect(renderToStaticMarkup(<RepositorySourcesPanel systemId={7} />)).toContain(">Edit</button>");
    expect(renderToStaticMarkup(<RepositorySourcesPanel systemId={7} readOnly />)).not.toContain(">Edit</button>");
  });

  test("explains why a file cannot be edited", () => {
    mockSources([sourceFile({ editable: false, editBlockedReason: "redacted", redacted: true })]);

    const html = renderToStaticMarkup(<RepositorySourcesPanel systemId={7} />);

    expect(html).not.toContain(">Edit</button>");
    expect(html).toContain("Contains masked credentials; edit it on the host so they are not lost.");
  });

  test("points to the system settings when editing is off", () => {
    mockSources([sourceFile({ editable: false, editBlockedReason: "disabled" })], false);

    const html = renderToStaticMarkup(<RepositorySourcesPanel systemId={7} onOpenSystemSettings={() => {}} />);

    expect(html).toContain("Turn on “Allow repository source editing” in the system settings");
    expect(html).toContain(">Open system settings</button>");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain(">Edit</button>");
    expect(renderToStaticMarkup(<RepositorySourcesPanel systemId={7} />)).not.toContain("Open system settings");
    expect(renderToStaticMarkup(<RepositorySourcesPanel systemId={7} readOnly />))
      .not.toContain("Allow repository source editing");
  });

  test("shows no hint when editing is on", () => {
    mockSources([sourceFile()], true);

    const html = renderToStaticMarkup(<RepositorySourcesPanel systemId={7} />);

    expect(html).not.toContain("Allow repository source editing");
    expect(html).not.toContain('type="checkbox"');
  });
});
