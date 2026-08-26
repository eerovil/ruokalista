import { defineConfig, devices } from "@playwright/test";

import { ensureDevVars } from "./tests/support/dev-vars.ts";

// Before anything starts, and deliberately not in a globalSetup: the `wrangler
// dev` below reads .dev.vars as it boots, so the values have to be on disk
// before this config is even handed back.
ensureDevVars();

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
  // No retries. The one flake this suite had turned out to be two real faults
  // — a spec with no reseed, and a tamper that sometimes decoded to the same
  // bytes — and a retry would have kept both hidden. If something starts
  // failing intermittently, that is the finding, not the noise.
  retries: 0,
  workers: 1,
  reporter: process.env["CI"] ? [["list"]] : [["html"], ["list"]],
  timeout: 30_000,

  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      testIgnore: /keep-awake-legacy\.spec\.ts/,
      use: {
        // A phone, because a week gets planned at the kitchen table.
        ...devices["Pixel 7"],
      },
    },
    {
      name: "legacy-ipad-fallback",
      testMatch: /keep-awake-legacy\.spec\.ts/,
      use: {
        // The closest reproducible target to pre-iPadOS-16.4 Safari: WebKit
        // with an iPad profile and the missing API reproduced explicitly.
        ...devices["iPad (gen 7)"],
        browserName: "webkit",
      },
    },
  ],

  webServer: {
    command: "npx wrangler dev --ip 127.0.0.1 --port 8787",
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
