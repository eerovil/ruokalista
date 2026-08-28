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

async function stubSenderSdk(
  page: Page,
  available = true,
  castState = "NOT_CONNECTED",
): Promise<void> {
  await page.route(`${SENDER_SDK}?*`, async (route: Route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
(function () {
  var listeners = [];
  var stateListeners = [];
  var castState = '${castState}';
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
    getCastState: function () { return castState; },
    addEventListener: function (type, listener) {
      if (type === 'caststate') stateListeners.push(listener);
      else listeners.push(listener);
    }
  };
  window.chrome = { cast: { AutoJoinPolicy: { ORIGIN_SCOPED: 'origin' } } };
  window.cast = { framework: {
    CastContext: { getInstance: function () { return context; } },
    CastContextEventType: {
      SESSION_STATE_CHANGED: 'session',
      CAST_STATE_CHANGED: 'caststate'
    },
    CastState: {
      NO_DEVICES_AVAILABLE: 'NO_DEVICES_AVAILABLE',
      NOT_CONNECTED: 'NOT_CONNECTED'
    },
    SessionState: {
      SESSION_STARTED: 'started',
      SESSION_RESUMED: 'resumed',
      SESSION_ENDED: 'ended'
    }
  } };
  window.__setCastStateForTest = function (next) {
    castState = next;
    stateListeners.forEach(function (listener) { listener({ castState: next }); });
  };
  window.__endCastForTest = function () {
    active = false;
    sessionStorage.setItem('cast-active', '0');
    listeners.forEach(function (listener) { listener({ sessionState: 'ended' }); });
  };
  window.__onGCastApiAvailable(${available ? "true" : "false"});
  var launcher = document.getElementById('cast-launcher');
  if (launcher) {
    launcher.addEventListener('click', function () {
      active = true;
      sessionStorage.setItem('cast-active', '1');
      listeners.forEach(function (listener) { listener({ sessionState: 'started' }); });
    });
    // Google's launcher hides itself with an inline style and does not
    // reliably undo that once a device turns up. Reproduced here so the
    // screen's own rules are what decide whether the button is on screen.
    launcher.style.display = 'none';
  }
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

test("the Cast action waits for a device rather than offering a dead label", async ({
  page,
}) => {
  await stubSenderSdk(page, true, "NO_DEVICES_AVAILABLE");
  await page.goto("/recipes/1");
  await expect(page.locator("#cast-action")).toBeHidden();

  await page.evaluate(() => {
    window.__setCastStateForTest("NOT_CONNECTED");
  });
  await expect(page.locator("#cast-action")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Näytä Cast-laitteet" }),
  ).toBeVisible();

  await page.evaluate(() => {
    window.__setCastStateForTest("NO_DEVICES_AVAILABLE");
  });
  await expect(page.locator("#cast-action")).toBeHidden();
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

async function stubReceiverSdk(page: Page): Promise<void> {
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
}

test("the public receiver renders a normal recipe in one 16:9 screen", async ({
  page,
}) => {
  await stubReceiverSdk(page);
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
  await expect(page.locator(".columns")).not.toHaveClass(/split/);
  expect(await fitScale(page)).toBe(1);
});

test("a long recipe on a small screen splits the ingredients instead of shrinking", async ({
  page,
}) => {
  await stubReceiverSdk(page);
  // A Nest Hub, which is where the unreadable screen in #180 was photographed.
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/cast/receiver");

  await page.evaluate((recipe) => {
    window.__castReceiverListener({ data: recipe });
  }, longRecipe());

  await expect(page.locator(".columns")).toHaveClass(/split/);
  expect(await page.locator(".ingredients li").count()).toBe(20);

  // The whole recipe is on screen, and it did not have to reach the floor of
  // the type scale to get there.
  expect(await page.evaluate(() => {
    const recipe = document.getElementById("recipe")!;
    return recipe.scrollHeight <= recipe.clientHeight;
  })).toBe(true);
  expect(await fitScale(page)).toBeGreaterThan(0.58);

  // Two lists side by side, not one column running off the bottom.
  const first = await page.locator(".ingredients li").first().boundingBox();
  const last = await page.locator(".ingredients li").last().boundingBox();
  expect(last!.x).toBeGreaterThan(first!.x + first!.width);
});

async function fitScale(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(document.getElementById("recipe")!.style.getPropertyValue("--fit"))
  );
}

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

/** The stroganoff of #180: twenty ingredient lines against nine steps. */
function longRecipe(): object {
  return {
    version: 1,
    title: "Mausteinen makkarastroganoff, perunoita ja raikasta salaattia",
    multiplier: "1×",
    ingredients: [{
      title: "",
      items: [
        "1 kg peruna",
        "½–1 tl suola",
        "¾ kpl purjo",
        "2–3 kpl valkosipulinkynsi",
        "1 pkt makkara",
        "1 rkl öljy",
        "1 tl suola",
        "½ tl mustapippuri",
        "1 tl kuivattu yrttisekoitus",
        "½–1 tl chilijauhe",
        "1 tl paprikajauhe",
        "3–4 rkl tomaattipyree",
        "2 rkl vehnäjauho",
        "5–6 dl vesi",
        "1 pkt maustekurkku",
        "1 prk ranskankerma",
        "1 ruukku salaatti",
        "1 kpl kurkku",
        "1 rkl oliiviöljy",
        "1 tl valkoviinietikka",
      ],
    }],
    instructions: [{
      title: "",
      items: [
        "Keitä kuoritut perunat suolatussa vedessä kypsiksi ja valuta.",
        "Suikaloi purjo, hienonna valkosipuli ja kuutioi makkara.",
        "Ruskista purjo, valkosipuli ja makkara öljyssä.",
        "Mausta suolalla, mustapippurilla, yrttisekoituksella, chilillä ja paprikajauheella.",
        "Sekoita joukkoon tomaattipyree ja vehnäjauhot.",
        "Lisää vesi vähitellen sekoittaen ja hauduta miedolla lämmöllä.",
        "Kuutioi maustekurkut ja sekoita ne kastikkeeseen.",
        "Valmista salaatti salaatista ja kurkusta ja mausta oliiviöljyllä sekä valkoviinietikalla.",
        "Tarjoile stroganoff perunoiden, ranskankerman ja salaatin kanssa.",
      ],
    }],
  };
}

declare global {
  interface Window {
    __setCastStateForTest(state: string): void;
    __castReceiverListener(event: { data: unknown }): void;
    __castReceiverNamespace: string;
    __castReceiverStarted: boolean;
  }
}
