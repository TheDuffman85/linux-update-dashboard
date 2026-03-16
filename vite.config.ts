import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import http from "http";
import { execSync } from "child_process";

function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function resolveRepoUrl(input: string): string {
  const trimmed = input.trim().replace(/\.git$/, "");
  if (!trimmed) return "";

  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}`;
  }

  const sshMatch = trimmed.match(/^git@github\.com:(.+\/.+)$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

function formatDevBuildVersion(date: Date = new Date()): string {
  return `dev-${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

const APP_BRANCH =
  process.env.VITE_APP_BRANCH || git("rev-parse --abbrev-ref HEAD");
const APP_VERSION =
  process.env.VITE_APP_VERSION || (APP_BRANCH === "dev" ? formatDevBuildVersion() : "");
const REPO_URL = resolveRepoUrl(
  process.env.VITE_APP_REPO_URL ||
    process.env.VITE_APP_REPOSITORY ||
    git("config --get remote.origin.url")
);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "ws-proxy",
      configureServer(server) {
        server.httpServer?.on("upgrade", (req, socket, head) => {
          if (!req.url?.startsWith("/api/ws")) return;

          const proxyReq = http.request(
            {
              hostname: "localhost",
              port: 3001,
              path: req.url,
              method: req.method,
              headers: req.headers,
            },
            () => {}
          );

          proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
            socket.write(
              "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                `Sec-WebSocket-Accept: ${_proxyRes.headers["sec-websocket-accept"]}\r\n` +
                "\r\n"
            );
            if (proxyHead.length) socket.write(proxyHead);
            proxySocket.pipe(socket);
            socket.pipe(proxySocket);
          });

          proxyReq.on("error", () => socket.destroy());
          socket.on("error", () => proxyReq.destroy());

          proxyReq.end();
        });
      },
    },
  ],
  root: "client",
  resolve: {
    alias: {
      "@client": path.resolve(__dirname, "client"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/client"),
    emptyOutDir: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_BUILD_DATE__: JSON.stringify(
      process.env.VITE_APP_BUILD_DATE || new Date().toISOString().slice(0, 10)
    ),
    __APP_COMMIT_HASH__: JSON.stringify(
      process.env.VITE_APP_COMMIT_HASH || git("rev-parse --short=8 HEAD")
    ),
    __APP_BRANCH__: JSON.stringify(APP_BRANCH),
    __APP_REPO_URL__: JSON.stringify(REPO_URL),
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
