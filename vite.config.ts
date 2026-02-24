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

const REPO_URL = "https://github.com/TheDuffman85/linux-update-dashboard";

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
    __APP_VERSION__: JSON.stringify(process.env.VITE_APP_VERSION || ""),
    __APP_BUILD_DATE__: JSON.stringify(
      process.env.VITE_APP_BUILD_DATE || new Date().toISOString().slice(0, 10)
    ),
    __APP_COMMIT_HASH__: JSON.stringify(
      process.env.VITE_APP_COMMIT_HASH || git("rev-parse --short=8 HEAD")
    ),
    __APP_BRANCH__: JSON.stringify(
      process.env.VITE_APP_BRANCH || git("rev-parse --abbrev-ref HEAD")
    ),
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
