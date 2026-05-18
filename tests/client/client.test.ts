import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, pollJob } from "../../client/lib/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("pollJob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("continues polling after a transient network failure", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("backend unavailable");
      return jsonResponse({ status: "done", result: { ok: true } });
    }));

    await expect(pollJob("job-1", 0, 3)).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("continues polling after a transient server error", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "warming up" }, 503);
      return jsonResponse({ status: "done", result: { ok: true } });
    }));

    await expect(pollJob("job-1", 0, 3)).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("uses recoverMissingJob when the backend forgot an in-memory job", async () => {
    const recoverMissingJob = vi.fn(async () => ({ status: "warning" }));
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: "Job not found" }, 404)
    ));

    await expect(
      pollJob("job-1", 0, 3, { recoverMissingJob }),
    ).resolves.toEqual({ status: "warning" });
    expect(recoverMissingJob).toHaveBeenCalledOnce();
  });

  test("fails immediately on auth errors", async () => {
    const recoverMissingJob = vi.fn(async () => ({ status: "warning" }));
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: "Unauthorized" }, 401)
    ));

    await expect(
      pollJob("job-1", 0, 3, { recoverMissingJob }),
    ).rejects.toMatchObject({ status: 401 } satisfies Partial<ApiError>);
    expect(recoverMissingJob).not.toHaveBeenCalled();
  });
});
