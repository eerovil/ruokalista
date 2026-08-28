import { expect, test, type Page, type Route } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

const SENDER_SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js";
const RECEIVER_SDK =
  "https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js";

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

async function stubSenderSdk(page: Page, available = true): Promise<void> {
  await page.route(`${SENDER_SDK}?*`, async (route: Route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
(function () {
  var listeners = [];
  var active = sessionStorage.getItem('cast-active') === '1';
  var session = {
    sendMessage: function (namespace, recipe) {
      var sent = JSON.parse(sessionStorage.getItem('cast-messages') || '[]');
      sent.push({ namespace: namespace, recipe: recipe });
      sessionStorage.setItem('cast-messages', JSON.stringify(sent));
      return Promise.resolve();
    }
  };
  var context = {
    setOptions: function (options) {
      sessionStorage.setItem('cast-options', JSON.stringify(options));
    },
    getCurrentSession: function () { return active ? session : null; },
    addEventListener: function (type, listener) { listeners.push(listener); }
  };
  window.chrome = { cast: { AutoJoinPolicy: { ORIGIN_SCOPED: 'origin' } } };
  window.cast = { framework: {
    CastContext: { getInstance: function () { return context; } },
    CastContextEventType: { SESSION_STATE_CHANGED: 'session' },
    SessionState: {
      SESSION_STARTED: 'started',
      SESSION_RESUMED: 'resumed',
      SESSION_ENDED: 'ended'
    }
  } };
  window.__endCastForTest = function () {
    active = false;
    sessionStorage.setItem('cast-active', '0');
    listeners.forEach(function (listener) { listener({ sessionState: 'ended' }); });
  };
  window.__onGCastApiAvailable(${available ? "true" : "false"});
  var launcher = document.getElementById('cast-launcher');
  if (launcher) launcher.addEventListener('click', function () {
    active = true;
    sessionStorage.setItem('cast-active', '1');
    listeners.forEach(function (listener) { listener({ sessionState: 'started' }); });
  });
}());`,
    });
  });
}

test("the Cast action appears only after the sender SDK is available", async ({
  page,
}) => {
  await stubSenderSdk(page, false);
  await page.goto("/recipes/1");
  await expect(page.locator("#cast-action")).toBeHidden();

  await stubSenderSdk(page);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Näytä Cast-laitteet" }),
  ).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("cast-options")))
    .toContain("test-cast-app");
});

test("selecting a device sends the scaled recipe and later recipe pages resync", async ({
  page,
}) => {
  await stubSenderSdk(page);
  await page.goto("/recipes/1?multiplier=1.5");
  await page.getByRole("button", { name: "Näytä Cast-laitteet" }).click();

  let messages = await sentMessages(page);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    namespace: "urn:x-cast:fi.eerovil.ruokalista.recipe",
    recipe: {
      version: 1,
      title: "Kaalilaatikko",
      multiplier: "1,5×",
      ingredients: [{
        items: expect.arrayContaining([
          "¾ dl öljy · ½ dl öljyä",
          "hieman sitruunaruohoa",
        ]),
      }],
    },
  });

  await page.goto("/recipes/3?multiplier=2");
  messages = await sentMessages(page);
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({
    recipe: { title: "Lasagne", multiplier: "2×" },
  });

  await page.evaluate(() => {
    (window as typeof window & { __endCastForTest(): void }).__endCastForTest();
  });
  await page.getByRole("link", { name: "Reseptit" }).click();
  await expect(page).toHaveURL(/\/recipes$/);
});

test("the public receiver renders a normal recipe in one 16:9 screen", async ({
  page,
}) => {
  await page.route(RECEIVER_SDK, async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
window.cast = { framework: { CastReceiverContext: { getInstance: function () {
  return {
    addCustomMessageListener: function (namespace, listener) {
      window.__castReceiverListener = listener;
      window.__castReceiverNamespace = namespace;
    },
    start: function () { window.__castReceiverStarted = true; }
  };
} } } };`,
    });
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  const response = await page.goto("/cast/receiver");
  expect(response?.status()).toBe(200);

  await page.evaluate((recipe) => {
    const receiver = window as typeof window & {
      __castReceiverListener(event: { data: unknown }): void;
    };
    receiver.__castReceiverListener({ data: recipe });
  }, normalRecipe());

  await expect(page.getByRole("heading", { name: "Kaalilaatikko" })).toBeVisible();
  await expect(page.getByText("1,5×")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ainekset" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Valmistus" })).toBeVisible();

  const ingredients = await page.locator(".ingredients").boundingBox();
  const instructions = await page.locator(".instructions").boundingBox();
  expect(ingredients).not.toBeNull();
  expect(instructions).not.toBeNull();
  expect(instructions!.x).toBeGreaterThan(ingredients!.x + ingredients!.width);
  expect(await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    recipeClientHeight: document.getElementById("recipe")!.clientHeight,
    recipeScrollHeight: document.getElementById("recipe")!.scrollHeight,
  }))).toEqual(expect.objectContaining({
    clientHeight: 1080,
    scrollHeight: 1080,
    recipeClientHeight: 1080,
    recipeScrollHeight: 1080,
  }));
});

async function sentMessages(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("cast-messages") ?? "[]")
  );
}

function normalRecipe(): object {
  return {
    version: 1,
    title: "Kaalilaatikko",
    multiplier: "1,5×",
    ingredients: [{
      title: "",
      items: [
        "¾ dl öljy",
        "1½–2¼ l vesi",
        "¾ kpl (750 g) valkokaali",
        "hieman sitruunaruohoa",
      ],
    }],
    instructions: [{
      title: "",
      items: [
        "Kuullota kaali öljyssä.",
        "Lisää vesi ja sitruunaruoho.",
        "Hauduta kaalilaatikko kypsäksi.",
      ],
    }],
  };
}

declare global {
  interface Window {
    __castReceiverListener(event: { data: unknown }): void;
    __castReceiverNamespace: string;
    __castReceiverStarted: boolean;
  }
}
