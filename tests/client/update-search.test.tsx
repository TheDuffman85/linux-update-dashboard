import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AvailableUpdatesSection,
  filterAvailableUpdates,
  getPackageSelectionState,
  normalizeSelectedPackageNames,
  toggleMatchingPackageNames,
} from "../../client/pages/SystemDetail";
import { translateForLanguage } from "../../client/lib/i18n";
import type { CachedUpdate } from "../../client/lib/systems";

const updates: CachedUpdate[] = [
  {
    id: 1,
    systemId: 1,
    packageName: "curl",
    currentVersion: "8.0",
    newVersion: "8.1",
    pkgManager: "apt",
    repository: "stable-security",
    architecture: "amd64",
    isSecurity: 1,
    isKeptBack: 0,
    cachedAt: "2026-10-06 12:00:00",
  },
  {
    id: 2,
    systemId: 1,
    packageName: "bash",
    currentVersion: null,
    newVersion: null,
    pkgManager: "dnf",
    repository: null,
    architecture: null,
    isSecurity: 0,
    isKeptBack: 1,
    cachedAt: "2026-10-06 12:00:00",
  },
];
const t = (key: string) => translateForLanguage("en", key);

describe("available update search", () => {
  test("matches partial names, versions, manager, repository, and translated badges", () => {
    for (const query of [
      "  CUR  ",
      "8.0",
      "8.1",
      "apt",
      "stable-security",
      "security",
    ]) {
      expect(
        filterAvailableUpdates(updates, query, t).map((update) => update.id),
        query,
      ).toEqual([1]);
    }
    expect(
      filterAvailableUpdates(updates, "kept back", t).map(
        (update) => update.id,
      ),
    ).toEqual([2]);
    const de = (key: string) => translateForLanguage("de", key);
    expect(
      filterAvailableUpdates(
        updates,
        de("pages.systemDetail.keptBack"),
        de,
      ).map((update) => update.id),
    ).toEqual([2]);
  });

  test("handles null fields, literal queries, whitespace, and excluded columns", () => {
    expect(filterAvailableUpdates(updates, "missing", t)).toEqual([]);
    expect(filterAvailableUpdates(updates, "curl|bash", t)).toEqual([]);
    expect(filterAvailableUpdates(updates, "amd64", t)).toEqual([]);
    expect(filterAvailableUpdates(updates, "", t)).toBe(updates);
    expect(filterAvailableUpdates(updates, " \t ", t)).toBe(updates);
    expect(filterAvailableUpdates([], "curl", t)).toEqual([]);
  });
});

describe("selection across searches", () => {
  test("selects and deselects matching names while preserving other selections", () => {
    const matches = filterAvailableUpdates(updates, "curl", t);
    const selected = toggleMatchingPackageNames(["bash"], matches);
    expect(selected).toEqual(["bash", "curl"]);
    expect(getPackageSelectionState(selected, matches)).toMatchObject({
      allSelected: true,
      indeterminate: false,
      selectedCount: 1,
    });
    expect(normalizeSelectedPackageNames(selected, updates)).toEqual([
      "bash",
      "curl",
    ]);
    expect(toggleMatchingPackageNames(selected, matches)).toEqual(["bash"]);
    expect(toggleMatchingPackageNames(selected, [])).toEqual(selected);
  });

  test("selects partial matches, deduplicates names, and handles disabled state", () => {
    const duplicates = [
      ...updates,
      { ...updates[0], id: 3, pkgManager: "snap" },
    ];
    expect(getPackageSelectionState(["curl"], duplicates)).toMatchObject({
      indeterminate: true,
      totalCount: 2,
    });
    const selected = toggleMatchingPackageNames(["curl"], duplicates);
    expect(selected).toEqual(["curl", "bash"]);
    expect(toggleMatchingPackageNames(selected, duplicates)).toEqual([]);
    expect(
      getPackageSelectionState(selected, duplicates, true).selectionDisabled,
    ).toBe(true);
  });
});

function renderSection(
  search: string,
  selectedPackageNames: string[] = [],
  data = updates,
  selectionDisabled = false,
) {
  return renderToStaticMarkup(
    <AvailableUpdatesSection
      system={{ securityCount: 1, keptBackCount: 1 }}
      updates={data}
      search={search}
      onSearchChange={() => {}}
      selectedPackageNames={selectedPackageNames}
      onHide={() => {}}
      onTogglePackage={() => {}}
      onToggleAllPackages={() => {}}
      selectionDisabled={selectionDisabled}
    />,
  );
}

describe("AvailableUpdatesSection", () => {
  test("renders search and retained selection counts", () => {
    const html = renderSection("curl", ["bash", "curl"]);
    expect(html).toContain('aria-label="Search available updates"');
    expect(html).toContain('aria-label="Clear available update search"');
    expect(html).not.toContain("Showing 1 of 2 updates");
    expect(html).toContain("Selected packages: 2");
    expect(html).toContain(
      "Selected packages outside the current search results: 1",
    );
    expect(html).toContain('aria-label="Select curl"');
    expect(html).not.toContain('aria-label="Select bash"');
  });

  test("distinguishes an empty snapshot from no matches and preserves selections", () => {
    const noMatches = renderSection("missing", ["curl"]);
    expect(noMatches).toContain("No updates match your search.");
    expect(noMatches).toContain(
      "Selected packages outside the current search results: 1",
    );
    expect(renderSection("", [], [])).toContain("No updates available");
    expect(renderSection("", [], [])).not.toContain("No updates match");
    expect(renderSection("curl", [], [])).toContain("No updates available");
  });

  test("keeps update selection disabled while a system operation is busy", () => {
    const html = renderSection("curl", ["curl"], updates, true);
    expect(html).toMatch(/aria-label="Select all packages"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Select curl"[^>]*disabled/);
  });
});
