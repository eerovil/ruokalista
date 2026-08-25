import { expect, test } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

test("a pre-Wake-Lock iPad gets a gesture-started media fallback", async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: undefined,
    });
    HTMLMediaElement.prototype.play = function () {
      const count = Number(sessionStorage.getItem("media-plays") ?? "0");
      sessionStorage.setItem("media-plays", String(count + 1));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      const count = Number(sessionStorage.getItem("media-pauses") ?? "0");
      sessionStorage.setItem("media-pauses", String(count + 1));
    };
  });

  await page.goto("/recipes/1");
  expect(await page.evaluate(() => navigator.userAgent)).toContain("iPad");
  expect(await page.evaluate(() => sessionStorage.getItem("media-plays"))).toBeNull();

  const button = page.getByRole("button", { name: "Pidä näyttö hereillä" });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator("#keep-awake-status")).toHaveText(
    "Näyttö pysyy hereillä.",
  );
  await expect(button).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem("media-plays"))).toBe("1");

  await setVisibility(page, "hidden");
  expect(await page.evaluate(() => sessionStorage.getItem("media-pauses"))).toBe(
    "1",
  );
  await setVisibility(page, "visible");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("media-plays")))
    .toBe("2");

  await page.goto("/recipes");
  expect(Number(await page.evaluate(() => sessionStorage.getItem("media-pauses"))))
    .toBeGreaterThanOrEqual(2);
  expect(errors).toEqual([]);
});

test("a refused media fallback leaves the recipe usable and retry visible", async ({
  page,
}) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: undefined,
    });
    HTMLMediaElement.prototype.play = function () {
      return Promise.reject(new DOMException("Gesture refused", "NotAllowedError"));
    };
  });

  await page.goto("/recipes/1");
  const button = page.getByRole("button", { name: "Pidä näyttö hereillä" });
  await button.click();

  await expect(button).toBeVisible();
  await expect(page.locator("#keep-awake-status")).toContainText("Näyttö voi sammua");
  await expect(page.getByRole("heading", { name: "Kaalilaatikko" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the embedded fallback media decodes and its rewind keeps it looping", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto("/recipes/1");
  await page.getByRole("button", { name: "Pidä näyttö hereillä" }).click();
  await expect(page.locator("#keep-awake-status")).toHaveText(
    "Näyttö pysyy hereillä.",
  );

  const video = page.locator(".keep-awake-video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({
    duration: element.duration,
    paused: element.paused,
    readyState: element.readyState,
  }))).toMatchObject({ paused: false, readyState: 4 });

  const rewoundTo = await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = 0.7;
    element.dispatchEvent(new Event("timeupdate"));
    return element.currentTime;
  });
  expect(rewoundTo).toBeCloseTo(0.1, 1);
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
