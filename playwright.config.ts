import { defineConfig, devices } from "@playwright/test";

import { ensureDevVars } from "./tests/support/dev-vars.ts";

// Before anything starts, and deliberately not in a globalSetup: the `wrangler
// dev` below reads .dev.vars as it boots, so the values have to be on disk
// before this config is even handed back.
ensureDevVars();

const browserPort = Number(process.env["PLAYWRIGHT_PORT"] ?? "8787");
if (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65_535) {
  throw new Error("PLAYWRIGHT_PORT must be a valid TCP port.");
}
const browserOrigin = `http://127.0.0.1:${browserPort}`;
const runWalkthrough = process.env["PLAYWRIGHT_WALKTHROUGH"] === "1";

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
    baseURL: browserOrigin,
    trace: "retain-on-failure",
    // Most specs create a fresh browser context per test, and some create a
    // second household context. Keep those tests about their own feature; the
    // dedicated PWA spec opts back into real workers and covers the full PWA
    // boundary without hundreds of short-lived registrations fighting the
    // browser harness.
    serviceWorkers: "block",
  },

  projects: [
    {
      name: "chromium",
      testIgnore: [
        /keep-awake-legacy\.spec\.ts/,
        ...(runWalkthrough ? [] : [/walkthrough\.spec\.ts/]),
      ],
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
    command: `npx wrangler dev --ip 127.0.0.1 --port ${browserPort}`,
    url: `${browserOrigin}/health`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
