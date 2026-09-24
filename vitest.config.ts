import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@client": path.resolve(__dirname, "client"),
      "@server": path.resolve(__dirname, "server"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Password hashing and key derivation are intentionally expensive and can
    // take considerably longer when the arm64 image is built through QEMU.
    testTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
