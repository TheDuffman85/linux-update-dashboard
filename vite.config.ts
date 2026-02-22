import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import http from "http";

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
