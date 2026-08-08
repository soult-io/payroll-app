import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Only used by `drizzle-kit migrate` at runtime — never by `generate`.
    url: process.env.DATABASE_URL ?? "postgres://payroll:payroll@localhost:5432/payroll",
  },
});
