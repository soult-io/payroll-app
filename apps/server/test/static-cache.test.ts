/**
 * Test cache headers for static assets in the SPA.
 *
 * Ensures that content-hashed assets under /assets/ use immutable caching
 * while index.html stays revalidating (for deploy detection).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "./helpers.js";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";

describe("static cache headers", () => {
  let ctx: TestContext;
  let originalPublicDir: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for our test fixtures
    tempDir = mkdtempSync(join(os.tmpdir(), "payroll-test-"));

    // Create assets directory first
    mkdirSync(join(tempDir, "assets"), { recursive: true });

    // Write test files to the temp directory
    writeFileSync(join(tempDir, "assets", "app-test123.js"), "console.log('test');\n");
    writeFileSync(join(tempDir, "index.html"), "<!DOCTYPE html><html></html>\n");

    // Save original PUBLIC_DIR and set our temp dir
    originalPublicDir = process.env.PUBLIC_DIR;
    process.env.PUBLIC_DIR = tempDir;
  });

  afterAll(async () => {
    // Restore original PUBLIC_DIR
    process.env.PUBLIC_DIR = originalPublicDir;

    // Close the test app
    await ctx?.close();

    // Clean up temp directory
    rmSync(tempDir, { recursive: true });
  });

  it("sets immutable cache headers for assets under /assets/", async () => {
    ctx = await createTestApp();

    const res = await ctx.app.inject({
      method: "GET",
      url: `/assets/app-test123.js`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("preserves revalidating behavior for index.html", async () => {
    ctx = await createTestApp();

    // Test index.html directly
    const res1 = await ctx.app.inject({
      method: "GET",
      url: `/index.html`,
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.headers["cache-control"]).toContain("max-age=0");
    expect(res1.headers["cache-control"]).not.toContain("immutable");

    // Test SPA fallback behavior (GET /)
    const res2 = await ctx.app.inject({
      method: "GET",
      url: `/`,
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.headers["cache-control"]).toContain("max-age=0");
    expect(res2.headers["cache-control"]).not.toContain("immutable");
  });
});
