import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import WebSocket from "ws";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const baseUrl = process.env.LUDASH_SCREENSHOT_BASE_URL || "http://127.0.0.1:5173";
const screenshotDir = process.env.LUDASH_SCREENSHOT_OUTPUT_DIR || scriptDir;
const chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const userDataDir = join(tmpdir(), `ludash-screenshots-chrome-${Date.now()}`);
const remotePort = Number.parseInt(process.env.LUDASH_SCREENSHOT_CHROME_PORT || "9223", 10);

mkdirSync(screenshotDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http
      .request(url, { method }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
    req.end();
  });
}

async function waitForChrome() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return await requestJson(`http://127.0.0.1:${remotePort}/json/version`);
    } catch {
      await sleep(150);
    }
  }
  throw new Error("Chrome did not expose DevTools in time");
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result ?? {});
      } else if (msg.method) {
        const handlers = this.events.get(msg.method) ?? [];
        for (const handler of handlers) handler(msg.params ?? {});
      }
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  on(method, handler) {
    const handlers = this.events.get(method) ?? [];
    handlers.push(handler);
    this.events.set(method, handlers);
  }

  close() {
    this.ws.close();
  }
}

async function createPage() {
  const tab = await requestJson(
    `http://127.0.0.1:${remotePort}/json/new?${encodeURIComponent(baseUrl)}`,
    "PUT",
  );
  const cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1843,
    height: 1136,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  return cdp;
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Evaluation failed");
  }
  return result.result?.value;
}

async function navigate(cdp, path) {
  let loaded = false;
  const onLoad = () => {
    loaded = true;
  };
  cdp.on("Page.loadEventFired", onLoad);
  await cdp.send("Page.navigate", { url: `${baseUrl}${path}` });
  const deadline = Date.now() + 12_000;
  while (!loaded && Date.now() < deadline) await sleep(100);
  await waitForAppSettled(cdp);
}

async function waitForAppSettled(cdp) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const settled = await evaluate(
      cdp,
      `(() => {
        const text = document.body.innerText || "";
        const hasSpinner = !!document.querySelector(".spinner");
        const hasMain = !!document.querySelector("main") || !!document.querySelector("[data-screenshot-ready]");
        return hasMain && !text.includes("Reconnecting to backend") && !hasSpinner;
      })()`,
    );
    if (settled) {
      await sleep(500);
      return;
    }
    await sleep(250);
  }
  await sleep(1000);
}

async function clickByText(cdp, text) {
  await evaluate(
    cdp,
    `(() => {
      const targetText = ${JSON.stringify(text)};
      const elements = [...document.querySelectorAll("button, a, summary")];
      const el = elements.find((node) => (node.innerText || node.textContent || "").trim().includes(targetText));
      if (!el) throw new Error("Could not find clickable text: " + targetText);
      el.click();
      return true;
    })()`,
  );
  await sleep(500);
  await waitForAppSettled(cdp);
}

async function clickFirst(cdp, selector) {
  await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error("Could not find selector: " + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()`,
  );
  await sleep(500);
  await waitForAppSettled(cdp);
}

async function prepareSession(cdp) {
  await navigate(cdp, "/dashboard");
  await evaluate(
    cdp,
    `(async () => {
      localStorage.setItem("theme", "light");
      document.documentElement.classList.remove("dark");
      await fetch("/api/auth/status", { credentials: "include" });
      const csrf = document.cookie.split("; ").find((v) => v.startsWith("ludash_csrf="))?.split("=")[1] || "";
      const status = await fetch("/api/auth/status", { credentials: "include" }).then((r) => r.json());
      if (status.setupRequired) {
        await fetch("/api/auth/setup", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) },
          body: JSON.stringify({ username: "admin", password: "ReadmeDemo1" })
        });
      } else if (!status.authenticated) {
        await fetch("/api/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) },
          body: JSON.stringify({ username: "admin", password: "ReadmeDemo1" })
        });
      }
      return true;
    })()`,
  );
}

async function screenshot(cdp, name) {
  await evaluate(
    cdp,
    `(() => {
      document.documentElement.classList.remove("dark");
      document.body.style.background = "#f8fafc";
      window.scrollTo(0, 0);
      return true;
    })()`,
  );
  await sleep(350);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  writeFileSync(join(screenshotDir, name), Buffer.from(data, "base64"));
}

async function main() {
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${remotePort}`,
    `${baseUrl}/dashboard`,
  ], { cwd: repoRoot, stdio: "ignore" });

  try {
    await waitForChrome();
    const cdp = await createPage();
    try {
      await prepareSession(cdp);

      await navigate(cdp, "/dashboard");
      await screenshot(cdp, "1.png");

      await clickByText(cdp, "Upgrade All");
      await screenshot(cdp, "12.png");

      await navigate(cdp, "/systems/1");
      await screenshot(cdp, "2.png");

      await clickByText(cdp, "Sudoers Setup");
      await screenshot(cdp, "13.png");

      await navigate(cdp, "/systems");
      await screenshot(cdp, "3.png");

      await clickFirst(cdp, "button[title='Edit system']");
      await screenshot(cdp, "4.png");

      await navigate(cdp, "/credentials");
      await screenshot(cdp, "5.png");

      await clickByText(cdp, "Add Credential");
      await screenshot(cdp, "6.png");

      await navigate(cdp, "/notifications");
      await screenshot(cdp, "7.png");

      await clickByText(cdp, "Add Notification");
      await screenshot(cdp, "8.png");

      await navigate(cdp, "/settings");
      await screenshot(cdp, "9.png");

      await navigate(cdp, "/schedules");
      await screenshot(cdp, "10.png");

      await navigate(cdp, "/scripts");
      await screenshot(cdp, "11.png");
    } finally {
      cdp.close();
    }
  } finally {
    chrome.kill("SIGTERM");
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
