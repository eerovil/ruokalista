import { expect, test } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("a recipe acquires, releases, and reacquires the standard wake lock", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const increment = (key: string) => {
      const current = Number(sessionStorage.getItem(key) ?? "0");
      sessionStorage.setItem(key, String(current + 1));
    };

    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request(kind: string) {
          sessionStorage.setItem("wake-kind", kind);
          increment("wake-requests");
          return Promise.resolve({
            addEventListener() {},
            release() {
              increment("wake-releases");
              return Promise.resolve();
            },
          });
        },
      },
    });
  });

  await page.goto("/recipes/1");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("wake-requests")))
    .toBe("1");
  expect(await page.evaluate(() => sessionStorage.getItem("wake-kind"))).toBe(
    "screen",
  );
  await expect(page.locator("#keep-awake")).toBeHidden();

  await setVisibility(page, "hidden");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("wake-releases")))
    .toBe("1");

  await setVisibility(page, "visible");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("wake-requests")))
    .toBe("2");

  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("wake-releases")))
    .toBe("2");
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("wake-requests")))
    .toBe("3");

  await page.goto("/recipes");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("wake-releases")))
    .toBe("3");
});

test("a native request settling after backgrounding is discarded", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      wakeResolvers: ((value: unknown) => void)[];
    };
    browserWindow.wakeResolvers = [];

    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request() {
          const count = Number(sessionStorage.getItem("late-requests") ?? "0");
          sessionStorage.setItem("late-requests", String(count + 1));
          return new Promise((resolve) => browserWindow.wakeResolvers.push(resolve));
        },
      },
    });
  });

  await page.goto("/recipes/1");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("late-requests")))
    .toBe("1");

  await setVisibility(page, "hidden");
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      wakeResolvers: ((value: unknown) => void)[];
    };
    browserWindow.wakeResolvers.shift()?.({
      addEventListener() {},
      release() {
        sessionStorage.setItem("late-release", "yes");
        return Promise.resolve();
      },
    });
  });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("late-release")))
    .toBe("yes");

  await setVisibility(page, "visible");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("late-requests")))
    .toBe("2");
});

test("a native rejection while backgrounding does not disable a later retry", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      wakeRejectors: ((reason?: unknown) => void)[];
    };
    browserWindow.wakeRejectors = [];

    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request() {
          const count = Number(sessionStorage.getItem("reject-requests") ?? "0");
          sessionStorage.setItem("reject-requests", String(count + 1));
          return new Promise((_resolve, reject) => {
            browserWindow.wakeRejectors.push(reject);
          });
        },
      },
    });
  });

  await page.goto("/recipes/1");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("reject-requests")))
    .toBe("1");

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const browserWindow = window as typeof window & {
      wakeRejectors: ((reason?: unknown) => void)[];
    };
    browserWindow.wakeRejectors.shift()?.(
      new DOMException("Backgrounded", "NotAllowedError"),
    );
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await setVisibility(page, "visible");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("reject-requests")))
    .toBe("2");
  await expect(page.locator("#keep-awake")).toBeHidden();
});

test("a refused standard lock offers the media fallback without breaking cooking", async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request() {
          return Promise.reject(new DOMException("Refused", "NotAllowedError"));
        },
      },
    });
    HTMLMediaElement.prototype.play = function () {
      sessionStorage.setItem("fallback-played", "yes");
      return Promise.resolve();
    };
  });

  await page.goto("/recipes/1");
  const fallback = page.getByRole("button", { name: "Pidä näyttö hereillä" });
  await expect(fallback).toBeVisible();
  await fallback.click();

  await expect(page.locator("#keep-awake-status")).toHaveText(
    "Näyttö pysyy hereillä.",
  );
  await expect(fallback).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem("fallback-played")))
    .toBe("yes");
  await expect(page.getByRole("heading", { name: "Kaalilaatikko" })).toBeVisible();
  expect(errors).toEqual([]);
});

async function setVisibility(
  page: import("@playwright/test").Page,
  state: "hidden" | "visible",
): Promise<void> {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: next,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}
