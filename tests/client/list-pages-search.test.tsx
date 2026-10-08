import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { filterBySearch } from "../../client/lib/list-search";

const state = vi.hoisted(() => ({
  search: "",
  items: [] as unknown[],
  language: "en" as "en" | "de",
  notificationPage: false,
  mutation: { mutate: vi.fn(), isPending: false },
  systems: [1, 2, 3].map((id) => ({ id, name: `Host ${id}` })),
  channels: [1, 2, 3].map((id) => ({ id, name: `Channel ${id}` })),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (initial === "") return [state.search, vi.fn()];
      if (Array.isArray(initial) && initial.length === 0) return [state.items, vi.fn()];
      return actual.useState(initial);
    },
  };
});
vi.mock("../../client/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../client/lib/i18n")>();
  return {
    ...actual,
    useI18n: () => ({ language: state.language, t: (key: string, values?: Record<string, string | number>) => actual.translateForLanguage(state.language, key, values) }),
  };
});
vi.mock("../../client/lib/credentials", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../client/lib/credentials")>(),
  useCredentials: () => ({ data: state.items }),
  useCredential: () => ({ data: undefined }),
  useCreateCredential: () => state.mutation,
  useUpdateCredential: () => state.mutation,
  useDeleteCredential: () => state.mutation,
  useReorderCredentials: () => state.mutation,
}));
vi.mock("../../client/lib/schedules", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../client/lib/schedules")>(),
  useSchedules: () => ({ data: state.items }),
  useCreateSchedule: () => state.mutation,
  useUpdateSchedule: () => state.mutation,
  useDeleteSchedule: () => state.mutation,
  useReorderSchedules: () => state.mutation,
}));
vi.mock("../../client/lib/notifications", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../client/lib/notifications")>(),
  useNotifications: () => ({ data: state.notificationPage ? state.items : state.channels }),
  useCreateNotification: () => state.mutation,
  useUpdateNotification: () => state.mutation,
  useDeleteNotification: () => state.mutation,
  useReorderNotifications: () => state.mutation,
  useResetNotificationUpdateDedupe: () => state.mutation,
  useTestNotification: () => state.mutation,
}));
vi.mock("../../client/lib/systems", () => ({ useVisibleSystems: () => ({ data: state.systems }) }));
vi.mock("../../client/lib/date-time", () => ({ useDateTime: () => ({ timeFormat: "24h", formatDateTime: () => "date" }) }));
vi.mock("../../client/context/ToastContext", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../../client/components/Layout", () => ({ Layout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../client/components/Modal", () => ({ Modal: () => null }));
vi.mock("../../client/components/ConfirmDialog", () => ({ ConfirmDialog: () => null }));

import Credentials from "../../client/pages/Credentials";
import Schedules from "../../client/pages/Schedules";
import Notifications from "../../client/pages/Notifications";

const credentials = [
  { id: 1, name: "Alpha credential", kind: "sshKey", referenceCount: 1, references: [{ name: "Host 3" }], payload: { privateKey: "secret-value" } },
  { id: 2, name: "Beta credential", kind: "usernamePassword", referenceCount: 0, references: [] },
];
const schedules = [
  { id: 1, name: "Alpha schedule", type: "refresh", enabled: true, systemIds: [1, 2, 3], config: { cron: "0 3 * * *", cacheDurationHours: 0 }, lastRunStatus: "warning", lastRunMessage: null },
  { id: 2, name: "Beta schedule", type: "notification_digest", enabled: false, systemIds: null, config: { cron: "0 9 * * 1", notificationIds: [1, 2, 3] }, lastRunStatus: null, lastRunMessage: null },
];
const notifications = [
  { id: 1, name: "Alpha notification", type: "email", enabled: true, systemIds: [1, 2, 3], notifyOn: ["updates"], schedule: null, scheduleNames: ["Morning", "Midday", "Evening"], schedules: [], config: { password: "secret-value" } },
  { id: 2, name: "Beta notification", type: "webhook", enabled: false, systemIds: null, notifyOn: ["unreachable"], schedule: null, scheduleNames: [], schedules: [], config: {} },
];

describe("list page search", () => {
  beforeEach(() => {
    state.search = "";
    state.language = "en";
    state.notificationPage = false;
  });

  test("handles literal, case-insensitive queries, whitespace, and null fields", () => {
    const items = [{ name: "Alpha [node]", extra: null }, { name: "Beta node", extra: undefined }];
    expect(filterBySearch(items, "  ALPHA\u00a0 [node]  ", (item) => [item.name, item.extra])).toEqual([items[0]]);
    expect(filterBySearch(items, ".*", (item) => [item.name])).toEqual([]);
    expect(filterBySearch(items, " \t ", () => { throw new Error("Empty queries should not inspect fields"); })).toBe(items);
  });

  for (const [Page, items, label, noun, emptyMessage] of [
    [Credentials, credentials, "Search credentials", "credentials", "No reusable credentials yet"],
    [Schedules, schedules, "Search schedules", "schedules", "No schedules configured yet"],
    [Notifications, notifications, "Search notifications", "notifications", "No notification channels configured yet"],
  ] as const) {
    test(`${noun}: accessible search, filtered rows, no matches, and restored ordering`, () => {
      state.items = [...items];
      state.notificationPage = Page === Notifications;
      const render = () => renderToStaticMarkup(<Page />);
      let html = render();
      expect(html).toContain(`aria-label="${label}"`);
      expect(html.indexOf(items[0].name)).toBeLessThan(html.indexOf(items[1].name));
      state.search = "  ALPHA  ";
      html = render();
      expect(html).toContain(items[0].name);
      expect(html).not.toContain(items[1].name);
      expect(html).toContain('aria-disabled="true"');
      expect(html).toContain('aria-label="Clear');
      expect(html).not.toContain("Showing ");
      expect(html).not.toContain("Clear search to reorder");
      state.search = "no-such-record";
      expect(render()).toContain(`No ${noun} match your search.`);
      state.search = " \t ";
      html = render();
      expect(html).toContain(items[1].name);
      expect(html).not.toContain('aria-disabled="true"');
      state.items = [];
      state.search = "";
      expect(render()).toContain(emptyMessage);
    });
  }

  test("credentials match translated types, references, and unused status without searching payloads", () => {
    state.items = credentials;
    state.language = "de";
    for (const query of ["ssh", "host 3"]) {
      state.search = query;
      const html = renderToStaticMarkup(<Credentials />);
      expect(html).toContain("Alpha credential");
      expect(html).not.toContain("Beta credential");
    }
    state.search = "secret-value";
    expect(renderToStaticMarkup(<Credentials />)).not.toContain("Alpha credential");
    state.search = "benutzer / passwort";
    expect(renderToStaticMarkup(<Credentials />)).toContain("Beta credential");
    state.language = "en";
    state.search = "unused";
    expect(renderToStaticMarkup(<Credentials />)).toContain("Beta credential");
  });

  test("schedules match all target names, cron, and translated status and types", () => {
    state.items = schedules;
    for (const [query, name] of [["host 3", "Alpha"], ["channel 3", "Beta"], ["0 3 * * *", "Alpha"], ["disabled", "Beta"]]) {
      state.search = query;
      const html = renderToStaticMarkup(<Schedules />);
      expect(html).toContain(`${name} schedule`);
      expect(html).not.toContain(`${name === "Alpha" ? "Beta" : "Alpha"} schedule`);
    }
    state.language = "de";
    state.search = "warnung";
    expect(renderToStaticMarkup(<Schedules />)).toContain("Alpha schedule");
  });

  test("notifications match hidden scope and delivery names, translated events, and exclude configuration", () => {
    state.items = notifications;
    state.notificationPage = true;
    for (const query of ["host 3", "evening", "email"]) {
      state.search = query;
      const html = renderToStaticMarkup(<Notifications />);
      expect(html).toContain("Alpha notification");
      expect(html).not.toContain("Beta notification");
    }
    state.language = "de";
    state.search = "nicht erreichbar";
    expect(renderToStaticMarkup(<Notifications />)).toContain("Beta notification");
    state.search = "secret-value";
    expect(renderToStaticMarkup(<Notifications />)).not.toContain("Alpha notification");
  });
});
