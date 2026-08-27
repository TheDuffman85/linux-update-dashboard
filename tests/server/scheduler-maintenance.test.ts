import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { schedules, systems } from "../../server/db/schema";
import * as scheduleService from "../../server/services/schedule-service";
import { schedulerTesting } from "../../server/services/scheduler";
import * as updateService from "../../server/services/update-service";

describe("maintenance schedules", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-maintenance-schedule-test-"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function insertSystems(): number[] {
    return getDb()
      .insert(systems)
      .values([
        { name: "Alpha", hostname: "alpha.local", username: "root" },
        { name: "Bravo", hostname: "bravo.local", username: "root" },
      ])
      .returning({ id: systems.id })
      .all()
      .map((row) => row.id);
  }

  test("runs autoremove for every system in the selected scope", async () => {
    const systemIds = insertSystems();
    const applyAutoremove = vi
      .spyOn(updateService, "applyAutoremove")
      .mockResolvedValueOnce({ success: true, output: "clean" })
      .mockResolvedValueOnce({ success: false, output: "failed" });
    const id = scheduleService.createSchedule({
      name: "Weekly cleanup",
      type: "autoremove",
      systemIds,
      config: { cron: "0 3 * * 0" },
    });

    await schedulerTesting.runAutoremoveSchedule(scheduleService.getSchedule(id)!);

    expect(applyAutoremove.mock.calls.map(([systemId]) => systemId)).toEqual(systemIds);
    const row = getDb().select().from(schedules).where(eq(schedules.id, id)).get();
    expect(row?.lastRunStatus).toBe("warning");
    expect(row?.lastRunMessage).toBe("Ran autoremove on 1 system, 1 failed");
  });

  test("keeps recurring reboot schedules enabled across runs", async () => {
    const [systemId] = insertSystems();
    const rebootSystem = vi
      .spyOn(updateService, "rebootSystem")
      .mockResolvedValue({ success: true, message: "Reboot command sent" });
    const id = scheduleService.createSchedule({
      name: "Maintenance reboot",
      type: "reboot",
      systemIds: [systemId],
      config: { cron: "0 3 * * 0" },
    });
    const schedule = scheduleService.getSchedule(id)!;

    await schedulerTesting.runRebootSchedule(schedule);
    await schedulerTesting.runRebootSchedule(schedule);

    expect(rebootSystem).toHaveBeenCalledTimes(2);
    expect(rebootSystem).toHaveBeenNthCalledWith(1, systemId);
    expect(rebootSystem).toHaveBeenNthCalledWith(2, systemId);
    const row = getDb().select().from(schedules).where(eq(schedules.id, id)).get();
    expect(row?.enabled).toBe(1);
    expect(row?.lastRunStatus).toBe("success");
    expect(row?.lastRunMessage).toBe("Sent reboot to 1 system");
  });
});
