import { describe, expect, test } from "bun:test";
import {
  buildActivityDisplayRows,
  isScrollNearBottom,
  matchesHistoryEntryToSession,
  resolveCurrentActivitySession,
} from "../../client/pages/SystemDetail";
import type { ActiveOperation, HistoryEntry } from "../../client/lib/systems";
import type { WsMessage } from "../../client/hooks/useCommandOutput";

function createHistoryEntry(overrides: Partial<HistoryEntry> & Pick<HistoryEntry, "id" | "action" | "pkgManager" | "status" | "startedAt">): HistoryEntry {
  return {
    systemId: 1,
    packageCount: null,
    packages: null,
    packagesList: [],
    command: null,
    steps: null,
    output: null,
    error: null,
    completedAt: null,
    ...overrides,
  };
}

describe("buildActivityDisplayRows", () => {
  test("creates a refresh session immediately from a check action hint", () => {
    const olderHistory = [
      createHistoryEntry({
        id: 1,
        action: "check",
        pkgManager: "apt",
        status: "success",
        packageCount: 0,
        startedAt: "2026-03-25 10:00:00",
        completedAt: "2026-03-25 10:00:05",
      }),
    ];
    const liveMessages: WsMessage[] = [
      { type: "started", command: "apt-get update", pkgManager: "apt", startedAt: "2026-03-25 11:00:01" },
      { type: "output", data: "Hit:1 mirror\n", stream: "stdout" },
    ];

    const session = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey: () => "activity-current-1",
      history: olderHistory,
      activeOp: null,
      actionHint: "check",
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const rows = buildActivityDisplayRows({
      history: olderHistory,
      activeOp: null,
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: session,
    });

    expect(session?.key).toBe("activity-current-1");
    expect(rows[0]?.key).toBe("activity-current-1");
    expect(rows[0]?.historyId).toBeNull();
    expect(rows[0]?.isRunning).toBe(true);
  });

  test("keeps the same key from the first live render through the final history handoff", () => {
    const olderHistory = [
      createHistoryEntry({
        id: 4,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-25 20:30:00",
        completedAt: "2026-03-25 20:31:00",
      }),
    ];
    const activeOp: ActiveOperation = {
      type: "check",
      startedAt: "2026-03-25 21:00:00",
    };
    const liveMessages: WsMessage[] = [
      { type: "started", command: "apt-get update", pkgManager: "apt", startedAt: "2026-03-25 21:00:01" },
      { type: "output", data: "Hit:1 mirror\n", stream: "stdout" },
    ];
    const finishedMessages: WsMessage[] = [
      ...liveMessages,
      { type: "done", success: true, completedAt: "2026-03-25 21:00:04" },
    ];
    const startedHistory = [
      createHistoryEntry({
        id: 12,
        action: "check",
        pkgManager: "apt",
        status: "started",
        command: "apt-get update",
        startedAt: "2026-03-25 21:00:01",
      }),
      ...olderHistory,
    ];
    const finalHistory = [
      createHistoryEntry({
        id: 14,
        action: "check",
        pkgManager: "apt",
        status: "success",
        packageCount: 3,
        command: "apt-get update",
        startedAt: "2026-03-25 21:00:01",
        completedAt: "2026-03-25 21:00:04",
      }),
      ...olderHistory,
    ];

    let nextSessionId = 0;
    const nextSessionKey = () => `activity-current-${++nextSessionId}`;

    const firstSession = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey,
      history: olderHistory,
      activeOp,
      actionHint: "check",
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const secondSession = resolveCurrentActivitySession({
      previousSession: firstSession,
      nextSessionKey,
      history: olderHistory,
      activeOp,
      actionHint: "check",
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const startedSession = resolveCurrentActivitySession({
      previousSession: secondSession,
      nextSessionKey,
      history: startedHistory,
      activeOp,
      actionHint: "check",
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
    });
    const finalSession = resolveCurrentActivitySession({
      previousSession: startedSession,
      nextSessionKey,
      history: finalHistory,
      activeOp: null,
      actionHint: "check",
      messages: finishedMessages,
      isCommandActive: false,
      pendingTransition: true,
    });
    const settledSession = resolveCurrentActivitySession({
      previousSession: finalSession,
      nextSessionKey,
      history: finalHistory,
      activeOp: null,
      actionHint: null,
      messages: finishedMessages,
      isCommandActive: false,
      pendingTransition: false,
    });

    const firstRows = buildActivityDisplayRows({
      history: olderHistory,
      activeOp,
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: firstSession,
    });
    const secondRows = buildActivityDisplayRows({
      history: olderHistory,
      activeOp,
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: secondSession,
    });
    const startedRows = buildActivityDisplayRows({
      history: startedHistory,
      activeOp,
      messages: liveMessages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: startedSession,
    });
    const finalRows = buildActivityDisplayRows({
      history: finalHistory,
      activeOp: null,
      messages: finishedMessages,
      isCommandActive: false,
      pendingTransition: true,
      currentSession: finalSession,
    });
    const settledRows = buildActivityDisplayRows({
      history: finalHistory,
      activeOp: null,
      messages: finishedMessages,
      isCommandActive: false,
      pendingTransition: false,
      currentSession: settledSession,
    });

    expect(firstSession?.key).toBe("activity-current-1");
    expect(secondSession?.key).toBe("activity-current-1");
    expect(startedSession?.key).toBe("activity-current-1");
    expect(finalSession?.key).toBe("activity-current-1");
    expect(settledSession?.key).toBe("activity-current-1");
    expect(firstRows[0]?.historyId).toBeNull();
    expect(startedRows[0]?.historyId).toBe(12);
    expect(finalRows[0]?.historyId).toBe(14);
    expect(firstRows[0]?.key).toBe("activity-current-1");
    expect(secondRows[0]?.key).toBe("activity-current-1");
    expect(startedRows[0]?.key).toBe("activity-current-1");
    expect(finalRows[0]?.key).toBe("activity-current-1");
    expect(settledRows[0]?.key).toBe("activity-current-1");
    expect(startedRows.filter((row) => row.historyId === 12)).toHaveLength(1);
    expect(finalRows.filter((row) => row.historyId === 14)).toHaveLength(1);
  });

  test("keeps a running DB-backed row single and uses live step details", () => {
    const history = [
      createHistoryEntry({
        id: 12,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "started",
        command: "apt-get upgrade -y",
        startedAt: "2026-03-25 20:00:00",
      }),
      createHistoryEntry({
        id: 8,
        action: "check",
        pkgManager: "apt",
        status: "success",
        packageCount: 0,
        startedAt: "2026-03-25 19:00:00",
        completedAt: "2026-03-25 19:00:05",
      }),
    ];
    const activeOp: ActiveOperation = {
      type: "upgrade_all",
      startedAt: "2026-03-25 19:59:59",
    };
    const messages: WsMessage[] = [
      { type: "started", command: "apt-get upgrade -y", pkgManager: "apt", startedAt: "2026-03-25 20:00:00" },
      { type: "output", data: "Reading package lists...\n", stream: "stdout" },
    ];
    const session = resolveCurrentActivitySession({
      previousSession: null,
      nextSessionKey: () => "activity-current-9",
      history,
      activeOp,
      actionHint: null,
      messages,
      isCommandActive: true,
      pendingTransition: true,
    });

    const rows = buildActivityDisplayRows({
      history,
      activeOp,
      messages,
      isCommandActive: true,
      pendingTransition: true,
      currentSession: session,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.historyId).toBe(12);
    expect(rows.filter((row) => row.historyId === 12)).toHaveLength(1);
    expect(rows[0]?.isRunning).toBe(true);
    expect(rows[0]?.useLiveDetails).toBe(true);
    expect(rows[0]?.liveSteps[0]?.output).toContain("Reading package lists");
  });
});

describe("matchesHistoryEntryToSession", () => {
  test("accepts a finalized history row that starts after the active-operation timestamp", () => {
    expect(
      matchesHistoryEntryToSession(
        createHistoryEntry({
          id: 20,
          action: "check",
          pkgManager: "apt",
          status: "success",
          startedAt: "2026-03-25 21:00:01",
          completedAt: "2026-03-25 21:00:04",
        }),
        {
          key: "activity-current-3",
          action: "check",
          activeStartedAt: "2026-03-25 21:00:00",
          firstCommandStartedAt: "2026-03-25 21:00:01",
        },
      )
    ).toBe(true);
  });
});

describe("isScrollNearBottom", () => {
  test("returns true when the viewer is already following the end of the log", () => {
    expect(isScrollNearBottom(600, 260, 300)).toBe(true);
  });

  test("returns false when the user has scrolled meaningfully away from the end", () => {
    expect(isScrollNearBottom(600, 200, 300)).toBe(false);
  });
});
