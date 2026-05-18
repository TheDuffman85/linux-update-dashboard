import { describe, expect, test, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  LOST_UPGRADE_JOB_RECOVERY_OUTPUT,
  recoverLostUpgradeJob,
} from "../../client/lib/updates";

describe("recoverLostUpgradeJob", () => {
  test("invalidates operation queries and returns a warning result", async () => {
    const invalidateQueries = vi.fn(async () => undefined);
    const queryClient = { invalidateQueries } as unknown as QueryClient;

    const result = await recoverLostUpgradeJob<{
      status: string;
      output: string;
      packageCount: number;
      packages: string[];
    }>(queryClient, 7, {
      packageCount: 2,
      packages: ["bash", "curl"],
    });

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["system", 7] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["systems"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
    expect(result).toEqual({
      status: "warning",
      output: LOST_UPGRADE_JOB_RECOVERY_OUTPUT,
      packageCount: 2,
      packages: ["bash", "curl"],
    });
  });
});
