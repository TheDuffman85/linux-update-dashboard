import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let envSnapshot: NodeJS.ProcessEnv;
const originalFetch = globalThis.fetch;

async function importFreshAppUpdateService() {
  const cacheBust = `${Date.now()}-${Math.random()}`;
  return await import(`../../server/services/app-update-service.ts?test=${cacheBust}`);
}

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("app update service", () => {
  test("checks GitHub releases for prod builds", async () => {
    process.env.LUDASH_APP_REPOSITORY = "TheDuffman85/linux-update-dashboard";
    process.env.LUDASH_APP_BRANCH = "main";
    process.env.LUDASH_APP_VERSION = "2026.3.1";

    globalThis.fetch = (async (input) => {
      const url = String(input);
      expect(url).toContain("/releases/latest");
      return new Response(
        JSON.stringify({
          tag_name: "2026.3.2",
          html_url:
            "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const { getAppUpdateStatus } = await importFreshAppUpdateService();
    const result = await getAppUpdateStatus(true);

    expect(result.updateAvailable).toBe(true);
    expect(result.currentBranch).toBe("main");
    expect(result.currentVersion).toBe("2026.3.1");
    expect(result.remoteVersion).toBe("2026.3.2");
    expect(result.releaseUrl).toContain("/releases/tag/2026.3.2");
  });

  test("checks GHCR dev tags for dev builds", async () => {
    process.env.LUDASH_APP_REPOSITORY = "TheDuffman85/linux-update-dashboard";
    process.env.LUDASH_APP_BRANCH = "dev";
    process.env.LUDASH_APP_VERSION = "dev-202603010101";

    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.startsWith("https://ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "ghcr-token" }), {
          status: 200,
        });
      }
      if (url.startsWith("https://ghcr.io/v2/")) {
        return new Response(
          JSON.stringify({
            tags: ["latest", "dev", "dev-202603020304"],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { getAppUpdateStatus } = await importFreshAppUpdateService();
    const result = await getAppUpdateStatus(true);

    expect(result.updateAvailable).toBe(true);
    expect(result.currentBranch).toBe("dev");
    expect(result.currentVersion).toBe("dev-202603010101");
    expect(result.remoteVersion).toBe("202603020304");
    expect(result.releaseUrl).toBeNull();
  });

  test("still resolves release metadata when app version env is missing", async () => {
    process.env.LUDASH_APP_REPOSITORY = "TheDuffman85/linux-update-dashboard";
    process.env.LUDASH_APP_BRANCH = "main";
    delete process.env.LUDASH_APP_VERSION;
    delete process.env.VITE_APP_VERSION;

    globalThis.fetch = (async (input) => {
      const url = String(input);
      expect(url).toContain("/releases/latest");
      return new Response(
        JSON.stringify({
          tag_name: "2026.3.99",
          html_url:
            "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.99",
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const { getAppUpdateStatus } = await importFreshAppUpdateService();
    const result = await getAppUpdateStatus(true);

    expect(result.currentVersion).toBeTruthy();
    expect(result.remoteVersion).toBe("2026.3.99");
    expect(result.releaseUrl).toContain("/releases/tag/2026.3.99");
  });
});
