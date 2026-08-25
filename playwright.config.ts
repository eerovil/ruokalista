import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run against a real `wrangler dev` with the seeded local
 * database — the same thing a person would poke at.
 *
 * No test calls Anthropic. Anything that would is intercepted with page.route()
 * and answered from a fixture, so the suite costs nothing to run.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  // One retry so a rare flake shows up as "flaky" in the report rather than
  // failing the run outright. It does not hide anything: Playwright reports
  // retried tests separately from passing ones.
  retries: 1,
  workers: 1,
  reporter: process.env["CI"] ? [["list"]] : [["html"], ["list"]],
  timeout: 30_000,

  use: {
    baseURL: "http://127.0.0.1:8787",
    // A phone, because a week gets planned at the kitchen table.
    ...devices["Pixel 7"],
    trace: "retain-on-failure",
  },

  webServer: {
    command: "npx wrangler dev --ip 127.0.0.1 --port 8787",
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
