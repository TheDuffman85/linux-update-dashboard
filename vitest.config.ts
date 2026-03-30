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
    restoreMocks: true,
    clearMocks: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
