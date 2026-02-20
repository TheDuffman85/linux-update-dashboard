import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.LUDASH_DB_PATH || "./data/dashboard.db",
  },
});
