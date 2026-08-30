import {
  expect,
  test,
  type Browser,
  type Page,
  type Route,
} from "@playwright/test";

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

async function receive(page: Page, recipe: object): Promise<void> {
  await page.evaluate((sent) => {
    window.__castReceiverListener({ data: sent });
  }, recipe);
}

test("the public receiver renders a normal recipe in one 16:9 screen", async ({
  page,
}) => {
  await stubReceiverSdk(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const response = await page.goto("/cast/receiver");
  expect(response?.status()).toBe(200);

  await receive(page, normalRecipe());

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

test("a long recipe splits the ingredients in two rather than shrinking to the floor", async ({
  page,
}) => {
  await stubReceiverSdk(page);
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/cast/receiver");

  await receive(page, longRecipe());
  await expect(page.getByRole("heading", { name: "Makkarastroganoff" }))
    .toBeVisible();

  await expect(page.locator(".columns")).toHaveClass("columns split");

  // Two sub-columns means the second half of the list sits beside the first,
  // not under it.
  const items = page.locator(".ingredients li");
  await expect(items).toHaveCount(20);
  const first = await items.first().boundingBox();
  const last = await items.last().boundingBox();
  expect(last!.x).toBeGreaterThan(first!.x + first!.width);

  // Nowhere near the .58 floor: with the width spent, the type gives almost no
  // ground. It is no longer exactly 1, because the small-panel type this change
  // ships starts bigger than a twenty-line recipe can quite hold (#227) — and
  // ends up larger than the old full-scale layout even so.
  const kept = await scale(page);
  expect(kept).toBeGreaterThan(0.9);
  expect(await page.evaluate(() => ({
    clientHeight: document.getElementById("recipe")!.clientHeight,
    scrollHeight: document.getElementById("recipe")!.scrollHeight,
  }))).toEqual({ clientHeight: 600, scrollHeight: 600 });

  // The layout it turned down: one ingredient column needs .76 for the same
  // recipe, which is what this change buys.
  expect(kept).toBeGreaterThan(await scaleForLayout(page, "columns"));
});

test("an instructions-heavy recipe is not split, because widening the ingredients would cost the long side", async ({
  page,
}) => {
  await stubReceiverSdk(page);
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/cast/receiver");

  await receive(page, wordyRecipe());
  await expect(page.getByRole("heading", { name: "Karjalanpaisti" }))
    .toBeVisible();

  // Splitting here would take width from the column that did not fit. The
  // receiver takes every layout all the way to the scale each needs, finds the
  // ingredient split ends smaller, and leaves the list in one column. What it
  // does instead is narrow that near-empty column and hand the width to the
  // method — `lean`, not `split` (#227).
  await expect(page.locator(".columns")).not.toHaveClass(/split/);
  const items = page.locator(".ingredients li");
  const first = await items.first().boundingBox();
  const last = await items.last().boundingBox();
  expect(last!.x).toBe(first!.x);

  const kept = await scale(page);
  expect(await page.evaluate(() => ({
    clientHeight: document.getElementById("recipe")!.clientHeight,
    scrollHeight: document.getElementById("recipe")!.scrollHeight,
  }))).toEqual({ clientHeight: 600, scrollHeight: 600 });

  // What the receiver avoided: forcing the split on this recipe and shrinking
  // from there ends up smaller than what it kept (.76 against .84 as this is
  // written). The property, not a fixed number — the layout that ships is
  // never smaller than the one the receiver turned down.
  expect(kept).toBeGreaterThan(await scaleForLayout(page, "columns split"));
});

test("a short recipe keeps one ingredient column at full size on a small receiver", async ({
  page,
}) => {
  await stubReceiverSdk(page);
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("/cast/receiver");

  await receive(page, normalRecipe());
  await expect(page.getByRole("heading", { name: "Kaalilaatikko" })).toBeVisible();

  await expect(page.locator(".columns")).toHaveClass("columns");
  const items = page.locator(".ingredients li");
  const first = await items.first().boundingBox();
  const last = await items.last().boundingBox();
  expect(last!.x).toBe(first!.x);
  expect(await scale(page)).toBe(1);
});

/*
 * ---------------------------------------------------------------------------
 * The Nest Hub, measured in millimetres (#227)
 *
 * #180 got a long recipe to fit on a 1024×600 receiver. Whether the result was
 * big enough to read was never checked, and a 1024×600 screenshot on a laptop
 * cannot answer it: the Hub packs those 1024 pixels into six inches, so its
 * text is physically about half the size the same picture shows on a desktop
 * monitor. These tests measure the rendered type against the panel's own
 * density instead, and the screenshots below are written at both scales.
 * ---------------------------------------------------------------------------
 */

/** The panel: 1024×600 pixels across seven diagonal inches, no ratio between. */
const NEST_HUB = { width: 1024, height: 600 };
const NEST_HUB_DIAGONAL_INCHES = 7;
const NEST_HUB_PPI =
  Math.hypot(NEST_HUB.width, NEST_HUB.height) / NEST_HUB_DIAGONAL_INCHES;
const MM_PER_INCH = 25.4;

/** A desktop monitor's nominal density — what a screenshot gets looked at on. */
const REVIEW_PPI = 96;

/**
 * The floor every recipe has to clear. An em of 2.5 mm is a cap height near
 * 1.8 mm, about six arcminutes at a metre — small, but clear of the four and a
 * half this screen was drawing before. It is a floor and not a target: the one
 * recipe that sits on it is fourteen paragraphs of method, which is close to
 * the most text a seven-inch panel can hold at any size at all. Raising the
 * floor past that would mean cutting recipes off, and having the whole thing on
 * one screen is the point of casting it.
 */
const READABLE_MM = 2.5;

/** What an ordinary long recipe should manage, rather than merely survive. */
const COMFORTABLE_MM = 3;

/** What one CSS pixel measures on the Hub's panel. */
function millimetres(px: number): number {
  return (px / NEST_HUB_PPI) * MM_PER_INCH;
}

/** The rendered font size of the first item in a column, in CSS pixels. */
async function itemFontSize(page: Page, column: string): Promise<number> {
  return page.evaluate((selector) =>
    Number.parseFloat(
      getComputedStyle(document.querySelector(selector)!).fontSize,
    ), `${column} li`);
}

/**
 * A page on the Hub's own pixels. Playwright's per-test viewport cannot carry a
 * device pixel ratio, so the receiver gets its own context: `deviceScaleFactor`
 * fixes what a screenshot pixel means, and 1 is what the Hub reports.
 */
async function nestHub(browser: Browser, deviceScaleFactor = 1): Promise<Page> {
  const context = await browser.newContext({
    viewport: NEST_HUB,
    deviceScaleFactor,
  });
  const page = await context.newPage();
  await stubReceiverSdk(page);
  await page.goto("/cast/receiver");
  return page;
}

test("the Nest Hub renders at its own pixel ratio, so a screenshot pixel is a panel pixel", async ({
  browser,
}) => {
  const page = await nestHub(browser);
  expect(await page.evaluate(() => ({
    ratio: window.devicePixelRatio,
    width: window.innerWidth,
    height: window.innerHeight,
  }))).toEqual({ ratio: 1, width: 1024, height: 600 });
  await page.context().close();
});

test("a long recipe stays physically readable on the Nest Hub's panel", async ({
  browser,
}) => {
  const page = await nestHub(browser);
  await receive(page, longRecipe());
  await expect(page.getByRole("heading", { name: "Makkarastroganoff" }))
    .toBeVisible();

  const ingredients = millimetres(await itemFontSize(page, ".ingredients"));
  const instructions = millimetres(await itemFontSize(page, ".instructions"));
  // 3.45 mm as this is written, against 2.53 mm before the change.
  expect(ingredients).toBeGreaterThanOrEqual(COMFORTABLE_MM);
  expect(instructions).toBeGreaterThanOrEqual(COMFORTABLE_MM);

  // And still all of it, on one screen — the whole reason for casting.
  expect(await page.evaluate(() => ({
    clientHeight: document.getElementById("recipe")!.clientHeight,
    scrollHeight: document.getElementById("recipe")!.scrollHeight,
  }))).toEqual({ clientHeight: 600, scrollHeight: 600 });
  await page.context().close();
});

test("an instructions-heavy recipe stays physically readable too", async ({
  browser,
}) => {
  const page = await nestHub(browser);
  await receive(page, wordyRecipe());
  await expect(page.getByRole("heading", { name: "Karjalanpaisti" }))
    .toBeVisible();

  // The worst case there is: 2.66 mm as this is written, against 2.13 mm
  // before. Fourteen paragraphs of method is about as much as the panel holds.
  const steps = millimetres(await itemFontSize(page, ".instructions"));
  expect(steps).toBeGreaterThanOrEqual(READABLE_MM);
  expect(await page.evaluate(() => ({
    clientHeight: document.getElementById("recipe")!.clientHeight,
    scrollHeight: document.getElementById("recipe")!.scrollHeight,
  }))).toEqual({ clientHeight: 600, scrollHeight: 600 });
  await page.context().close();
});

test("the Nest Hub review pictures are written at panel scale and at life size", async ({
  browser,
}) => {
  // Panel scale: 1024×600 CSS pixels at ratio 1, so the PNG is exactly the
  // pixels the Hub lights up.
  const panel = await nestHub(browser);
  await receive(panel, longRecipe());
  await expect(panel.locator(".ingredients li")).toHaveCount(20);
  await expect(panel.getByRole("heading", { name: "Makkarastroganoff" }))
    .toBeVisible();
  await capture(panel, { path: `${SHOTS}/110-cast-nest-hub.png` });
  await panel.context().close();

  // Life size: the same 1024×600 layout rasterised at the ratio that makes the
  // PNG measure six inches across on a 96 dpi monitor — which is what the
  // panel measures. Looked at 1:1, this picture is the kitchen's view.
  const life = await nestHub(browser, REVIEW_PPI / NEST_HUB_PPI);
  await receive(life, longRecipe());
  await expect(life.locator(".ingredients li")).toHaveCount(20);
  await expect(life.getByRole("heading", { name: "Makkarastroganoff" }))
    .toBeVisible();
  await capture(life, { path: `${SHOTS}/111-cast-nest-hub-life-size.png` });
  await life.context().close();
});

const SHOTS = "docs/screenshots";
const writeScreenshots = process.env["PLAYWRIGHT_SCREENSHOTS"] === "1";

/** Review artifacts, written only when asked for — see docs/screenshots. */
async function capture(
  page: Page,
  options: Parameters<Page["screenshot"]>[0],
): Promise<void> {
  if (writeScreenshots) await page.screenshot(options);
}

/**
 * The scale the other layout would have needed. Runs the receiver's own shrink
 * loop against a forced layout, so a test can say "what shipped is no smaller
 * than what was turned down" without hard-coding either number. Destructive:
 * call it after the assertions about what the receiver actually chose.
 */
async function scaleForLayout(page: Page, className: string): Promise<number> {
  return page.evaluate((layout) => {
    const root = document.getElementById("recipe")!;
    root.querySelector(".columns")!.className = layout;
    let scale = 1;
    root.style.setProperty("--fit", String(scale));
    while (root.scrollHeight > root.clientHeight && scale > 0.58) {
      scale = Math.round((scale - 0.02) * 100) / 100;
      root.style.setProperty("--fit", String(scale));
    }
    return scale;
  }, className);
}

async function scale(page: Page): Promise<number> {
  return page.evaluate(() =>
    Number(
      getComputedStyle(document.getElementById("recipe")!)
        .getPropertyValue("--fit"),
    )
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

/** The kitchen's worst case: 20 ingredient lines and 9 steps (#180). */
function longRecipe(): object {
  return {
    version: 1,
    title: "Mausteinen makkarastroganoff, perunoita ja raikasta salaattia",
    multiplier: "1×",
    ingredients: [{
      title: "",
      items: [
        "400 g nautamakkaraa",
        "2 kpl sipulia",
        "3 kynttä valkosipulia",
        "2 rkl tomaattipyreetä",
        "2 dl kermaa",
        "2 dl lihalientä",
        "1 rkl sinappia",
        "1 tl paprikajauhetta",
        "1 tl savupaprikaa",
        "½ tl chilirouhetta",
        "1 tl kuivattua timjamia",
        "2 laakerinlehteä",
        "1 rkl voita",
        "1 rkl öljyä",
        "800 g perunoita",
        "1 nippu tilliä",
        "1 kpl jäävuorisalaattia",
        "2 kpl tomaattia",
        "1 kpl kurkkua",
        "hieman suolaa ja mustapippuria",
      ],
    }],
    instructions: [{
      title: "",
      items: [
        "Kuori perunat ja keitä ne kypsiksi suolatussa vedessä.",
        "Kuutioi makkara ja ruskista se voi-öljyseoksessa.",
        "Lisää sipuli ja valkosipuli, kuullota pehmeiksi.",
        "Lisää tomaattipyree ja kypsennä hetki.",
        "Kaada joukkoon lihaliemi ja mausteet.",
        "Hauduta kastiketta noin 20 minuuttia.",
        "Lisää kerma ja sinappi, tarkista maku.",
        "Pilko salaatti, tomaatti ja kurkku kulhoon.",
        "Tarjoa stroganoff perunoiden, tillin ja salaatin kanssa.",
      ],
    }],
  };
}

/** The other way round: four ingredients and a page of method (#180). */
function wordyRecipe(): object {
  return {
    version: 1,
    title: "Karjalanpaisti",
    multiplier: "1×",
    ingredients: [{
      title: "",
      items: [
        "1 kg naudan lapaa",
        "2 kpl sipulia",
        "2 kpl porkkanaa",
        "1 rkl kokonaisia maustepippureita",
      ],
    }],
    instructions: [{
      title: "",
      items: [
        "Ota liha huoneenlämpöön hyvissä ajoin ennen kuin alat valmistaa paistia, jotta se kypsyy tasaisesti.",
        "Leikkaa liha reiluiksi paloiksi ja poista suurimmat kalvot, mutta jätä rasva paikoilleen makua antamaan.",
        "Kuori sipulit ja lohko ne neljään osaan, kuori porkkanat ja paloittele ne paksuiksi kiekoiksi.",
        "Ripottele padan pohjalle osa mausteista, lado sitten liha ja kasvikset kerroksittain padan täyteen.",
        "Ripottele loput maustepippurit ja suola päällimmäisen kerroksen päälle.",
        "Kaada pataan kylmää vettä sen verran, että se juuri peittää lihat, äläkä sekoita sen jälkeen.",
        "Kuumenna uuni 150 asteeseen ja nosta pata kannen kanssa uunin alatasolle.",
        "Anna paistin hautua rauhassa vähintään kolme tuntia, mieluummin neljä, kunnes liha hajoaa haarukalla.",
        "Tarkista puolivälissä, että nestettä on yhä riittävästi, ja lisää tarvittaessa kuumaa vettä.",
        "Ota kansi pois viimeisen puolen tunnin ajaksi, jos haluat pinnalle hieman väriä.",
        "Nosta pata uunista ja anna sen tasaantua liedellä kymmenen minuuttia ennen tarjoilua.",
        "Maista ja lisää suolaa vasta nyt, sillä liemi väkevöityy pitkän haudutuksen aikana.",
        "Tarjoa paisti perunamuusin tai keitettyjen perunoiden ja puolukkasurvoksen kanssa.",
        "Säilytä tähteet liemessään jääkaapissa, sillä paisti maistuu seuraavana päivänä vielä paremmalta.",
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
