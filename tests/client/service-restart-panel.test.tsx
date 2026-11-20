import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ServiceRestartPanel } from "../../client/components/systems/ServiceRestartPanel";
import { ToastProvider } from "../../client/context/ToastContext";
import type { System } from "../../client/lib/systems";
import type { ServiceRestartInfo } from "../../shared/service-restart";

function render(info: ServiceRestartInfo) {
  const system = {
    id: 1,
    name: "Host",
    serviceRestartInfo: info,
    serviceRestartCount: info.services.length,
    serviceRestartSkipPatterns: null,
    activeOperation: null,
  } as unknown as System;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ServiceRestartPanel system={system} readOnly={false} busy={false} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const empty: ServiceRestartInfo = {
  status: "ok",
  init: "systemd",
  services: [],
  managerNeedsReexec: false,
  sessionProcessCount: 0,
  otherProcesses: [],
};

describe("ServiceRestartPanel", () => {
  test("renders nothing when a complete scan found nothing", () => {
    expect(render(empty)).toBe("");
  });

  test("asks for a refresh when every service restarted but the check afterwards did not finish", () => {
    expect(render({ ...empty, stale: true })).toContain("out of date");
  });

  test("recommends daemon-reexec only for systemd", () => {
    expect(render({ ...empty, managerNeedsReexec: true })).toContain("systemctl daemon-reexec");
    const openrc = render({ ...empty, init: "openrc", managerNeedsReexec: true });
    expect(openrc).not.toContain("daemon-reexec");
    expect(openrc).toContain("Reboot the system");
  });
});
