import { expect, test, type Page } from "@playwright/test";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The grouped week: one card per cooked batch however many meals it feeds,
 * no left-hand timeline rail, and today made obvious in the current week.
 *
 * "Today" is today in Helsinki, the same way `src/dates.ts` decides it, so
 * these keep working whichever day they are run on.
 */

const MONDAY = "2026-12-07";

test.beforeAll(reseed);

test.beforeEach(async ({ context }) => {
  await context.addCookies([sessionCookie(1)]);
});

/**
 * First in the file on purpose: `reseed` plants no batches, and only the
 * today test below puts one in the current week, so this is the one place
 * an empty current week can be seen.
 */
test("an empty current week still opens on today", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator(".batch-card")).toHaveCount(0);
  const today = page.locator(".day.is-today");
  await expect(today).toHaveAttribute("id", "tanaan");

  // Seven day headings and fourteen add links are taller than a phone, so
  // there is something to scroll past — and it was scrolled past.
  const viewport = page.viewportSize()!;
  expect(await page.evaluate(() => document.body.scrollHeight)).toBeGreaterThan(
    viewport.height,
  );
  const box = await today.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeLessThan(viewport.height);

  // Monday is above the fold unless today is Monday.
  const offset = await page.evaluate(() => window.pageYOffset);
  const isMonday = await page
    .locator(".day")
    .first()
    .evaluate((element) => element.classList.contains("is-today"));
  if (isMonday) expect(offset).toBe(0);
  else expect(offset).toBeGreaterThan(0);
});

test("a batch spanning three days is one card with three occurrence rows", async ({
  page,
}) => {
  const spanning = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, spanning, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "dinner"],
    ["2026-12-09", "lunch"],
    ["2026-12-09", "dinner"],
  ]);
  const alongside = await createBatch(page, MONDAY, "dinner", 2);
  await setCoverage(page, alongside, [
    ["2026-12-07", "dinner"],
    ["2026-12-08", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);

  const card = page.locator(`.batch-card[data-batch-id="${spanning}"]`);
  await expect(card).toHaveCount(1);
  await expect(card.locator(".entry-title")).toHaveText("Kaalilaatikko");
  await expect(card.locator(".batch-start")).toHaveText("Kokataan · 1×");
  await expect(card.locator(".batch-when-weekday")).toHaveText([
    "ma",
    "ti",
    "ke",
  ]);
  await expect(card.locator(".batch-when-date")).toHaveText([
    "7.12.",
    "8.12.",
    "9.12.",
  ]);
  await expect(card.locator(".batch-when-slots")).toHaveText([
    "Lounas",
    "Päivällinen",
    "Lounas · Päivällinen",
  ]);
  await expect(card.locator(".batch-end")).toHaveText("viimeinen annos");

  // Both full cards stay anchored on Monday. Later covered days summarize the
  // continuing recipes instead of repeating those action surfaces.
  const days = page.locator(".day");
  await expect(days.nth(0).locator(".batch-card")).toHaveCount(2);
  await expect(days.nth(1).locator(".batch-card")).toHaveCount(0);
  await expect(days.nth(2).locator(".batch-card")).toHaveCount(0);
  await expect(page.locator(".batch-card")).toHaveCount(2);
  await expect(days.nth(0).locator(".continuing-card")).toHaveCount(0);

  const tuesday = days.nth(1);
  await expect(tuesday.locator(".covered-status")).toHaveText("✓ katettu");
  await expect(tuesday.locator(".continuing-title")).toHaveText([
    "Öljykastike",
    "Kaalilaatikko",
  ]);
  await expect(tuesday.locator(".continuing-slots")).toHaveText([
    "Lounas",
    "Päivällinen",
  ]);

  const wednesday = days.nth(2);
  await expect(wednesday.locator(".covered-status")).toHaveText("✓ katettu");
  await expect(wednesday.locator(".continuing-row")).toHaveCount(1);
  await expect(wednesday.locator(".continuing-title")).toHaveText(
    "Kaalilaatikko",
  );
  await expect(wednesday.locator(".continuing-slots")).toHaveText(
    "Lounas · Päivällinen",
  );

  // The card is still the way into everything you can do to the batch.
  await card.locator(".entry a").click();
  await expect(page).toHaveURL(new RegExp(`/batches/${spanning}$`));
  await expect(page.getByRole("link", { name: "Jatkuu…" })).toBeVisible();
});

test("two continuing batches of one recipe share one summary row", async ({
  page,
}) => {
  const monday = "2027-02-01";
  const tuesday = "2027-02-02";
  const lunches = await createBatch(page, monday, "lunch", 1);
  const dinners = await createBatch(page, monday, "dinner", 1);
  await setCoverage(page, lunches, [
    [monday, "lunch"],
    [tuesday, "lunch"],
  ]);
  await setCoverage(page, dinners, [
    [monday, "dinner"],
    [tuesday, "dinner"],
  ]);

  await page.goto(`/?week=${monday}`);
  const tuesdaySection = page.locator(".day").nth(1);
  await expect(tuesdaySection.locator(".continuing-row")).toHaveCount(1);
  await expect(tuesdaySection.locator(".continuing-title")).toHaveText(
    "Kaalilaatikko",
  );
  await expect(tuesdaySection.locator(".continuing-slots")).toHaveText(
    "Lounas · Päivällinen",
  );
  await expect(tuesdaySection.locator(".covered-status")).toHaveText(
    "✓ katettu",
  );
});

test("the left-hand timeline rail is gone", async ({ page }) => {
  const id = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, id, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);
  await expect(page.locator(".batch-rail")).toHaveCount(0);
  await expect(page.locator(".batch-track")).toHaveCount(0);
  await expect(page.locator(".batch-rail-line")).toHaveCount(0);
});

test("a batch open at either visible edge says so instead of ending", async ({
  page,
}) => {
  const edgeMonday = "2027-03-01";
  const fromPreviousWeek = await createBatch(page, "2027-02-28", "dinner", 1);
  await setCoverage(page, fromPreviousWeek, [
    ["2027-02-28", "dinner"],
    ["2027-03-01", "lunch"],
    ["2027-03-02", "dinner"],
  ]);
  const intoNextWeek = await createBatch(page, "2027-03-05", "lunch", 2);
  await setCoverage(page, intoNextWeek, [
    ["2027-03-05", "lunch"],
    ["2027-03-06", "lunch"],
    ["2027-03-07", "dinner"],
    ["2027-03-08", "lunch"],
  ]);

  await page.goto(`/?week=${edgeMonday}`);

  const carried = page.locator(`.batch-card[data-batch-id="${fromPreviousWeek}"]`);
  await expect(carried.locator(".batch-carried")).toHaveText(
    "Kokattu 28.2. · 1×",
  );
  await expect(carried.locator(".batch-start")).toHaveCount(0);
  await expect(carried.locator(".batch-end")).toHaveText("viimeinen annos");
  const days = page.locator(".day");
  await expect(days.first().locator(".continuing-card")).toHaveCount(0);
  await expect(days.nth(1).locator(".continuing-title")).toHaveText(
    "Kaalilaatikko",
  );
  await expect(days.nth(1).locator(".continuing-slots")).toHaveText(
    "Päivällinen",
  );

  const onward = page.locator(`.batch-card[data-batch-id="${intoNextWeek}"]`);
  await expect(onward.locator(".batch-start")).toHaveText("Kokataan · 1×");
  await expect(onward.locator(".batch-onward")).toHaveText("jatkuu ensi viikolle");
  await expect(onward.locator(".batch-end")).toHaveCount(0);
});

test("every day keeps its own add action, with no duplicated wording", async ({
  page,
}) => {
  const id = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, id, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);
  await expect(page.locator(".slot-actions a")).toHaveCount(14);
  await expect(page.getByRole("link", { name: "+ Lisää toinen" })).toHaveCount(0);
  const monday = page.locator(".day").first();
  await expect(monday.locator(".slot-actions a")).toHaveText([
    "+ Lounas",
    "+ Päivällinen",
  ]);
  await expect(
    page.locator(".day").nth(1).locator(".slot-actions a"),
  ).toHaveText(["+ Lounas", "+ Päivällinen"]);
  await monday.locator(".slot-actions a").first().click();
  await expect(page).toHaveURL(/\/picker\?date=2026-12-07&slot=lunch$/);
});

test("the current week marks today and opens on it", async ({ page }) => {
  const now = helsinkiToday();
  const id = await createBatch(page, now, "lunch", 1);
  await setCoverage(page, id, [
    [now, "lunch"],
    [addDays(now, 1), "lunch"],
  ]);

  await page.goto("/");

  const today = page.locator(".day.is-today");
  await expect(today).toHaveCount(1);
  await expect(today).toHaveAttribute("id", "tanaan");
  await expect(today.locator(".today-badge")).toHaveText("Tänään");
  await expect(today.locator(`.batch-card[data-batch-id="${id}"]`)).toHaveCount(1);

  // Today's section is in view when the week opens, wherever in the week it is.
  const box = await today.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeLessThan(viewport.height);

  // And there is a way back to it after scrolling away.
  await page.getByRole("link", { name: "Tänään" }).first().click();
  await expect(page).toHaveURL(/#tanaan$/);
});

test("browsing another week neither marks nor jumps to a day", async ({
  page,
}) => {
  const id = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, id, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "lunch"],
  ]);

  await page.goto(`/?week=${MONDAY}`);
  await expect(page.locator(".day.is-today")).toHaveCount(0);
  await expect(page.locator("#tanaan")).toHaveCount(0);
  await expect(page.locator(".to-today")).toHaveCount(0);
  expect(await page.evaluate(() => window.pageYOffset)).toBe(0);
});

test("a week of grouped cards keeps usable phone-width cards", async ({
  page,
}) => {
  for (let index = 0; index < 10; index += 1) {
    const id = await createBatch(
      page,
      MONDAY,
      index % 2 === 0 ? "lunch" : "dinner",
      index % 2 === 0 ? 1 : 2,
    );
    await setCoverage(page, id, [
      ["2026-12-07", index % 2 === 0 ? "lunch" : "dinner"],
      ["2026-12-08", index % 2 === 0 ? "dinner" : "lunch"],
      ["2026-12-09", index % 2 === 0 ? "lunch" : "dinner"],
    ]);
  }

  await page.goto(`/?week=${MONDAY}`);

  const dimensions = await page.evaluate(() => ({
    cardWidth: document.querySelector(".entry a")!.getBoundingClientRect().width,
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.pageWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.cardWidth).toBeGreaterThanOrEqual(270);
});

/**
 * Last in the file, because it renames a seeded recipe and the tests above
 * still expect the seed titles.
 *
 * The card head is a flex row of a fixed thumbnail, the title and a multiplier
 * pill, inside a card that clips what overflows it. A long Finnish compound
 * beside the widest pill — the carried `Kokattu 6.12. · 1×` — is what runs that
 * row out of width. #165 made that pill narrower than the portion count it
 * replaced, so this has more slack than it did; the check is still that nothing
 * is cut off inside the card, not merely that the page does not scroll
 * sideways.
 */
test("a long recipe name wraps in the card head instead of being cut off", async ({
  page,
}) => {
  // One unbroken compound, which is the worst case: there is no space for the
  // browser to wrap at, so only the card's own rules can keep it inside.
  const longTitle = "Kesakurpitsalasagnetortillavuokakermaviilikastikkeella";
  await page.goto("/recipes/1/edit");
  await page.locator("#title").fill(longTitle);
  await page.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(page.getByRole("heading", { name: longTitle })).toBeVisible();

  // One cooked inside the week, one carried in from the previous Sunday —
  // the carried pill is the widest thing the head ever has to hold.
  const cooked = await createBatch(page, MONDAY, "lunch", 1);
  await setCoverage(page, cooked, [
    ["2026-12-07", "lunch"],
    ["2026-12-08", "lunch"],
  ]);
  const carried = await createBatch(page, "2026-12-06", "dinner", 1);
  await setCoverage(page, carried, [
    ["2026-12-06", "dinner"],
    ["2026-12-07", "dinner"],
  ]);

  await page.goto(`/?week=${MONDAY}`);
  await expect(
    page.locator(`.batch-card[data-batch-id="${carried}"] .batch-carried`),
  ).toHaveText("Kokattu 6.12. · 1×");

  const overflow = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".batch-card")];
    return cards.map((card) => {
      const box = card.getBoundingClientRect();
      const parts = [...card.querySelectorAll(".entry-title, .batch-start, .batch-carried, .batch-when-slots")];
      return {
        id: card.getAttribute("data-batch-id"),
        // The card clips what does not fit, so its own content extent is the
        // honest measure of whether anything was cut off.
        clipped: card.scrollWidth - card.clientWidth,
        // A single long word can also overflow its own box.
        wordOverflow: Math.max(
          ...parts.map((part) => part.scrollWidth - part.clientWidth),
        ),
        // And nothing may sit outside the card's right edge.
        spill: Math.max(
          ...parts.map((part) => part.getBoundingClientRect().right - box.right),
        ),
      };
    });
  });

  expect(overflow.length).toBeGreaterThanOrEqual(2);
  for (const card of overflow) {
    expect(card.clipped, `card ${card.id} clips its own content`).toBeLessThanOrEqual(1);
    expect(card.wordOverflow, `card ${card.id} overflows a child box`).toBeLessThanOrEqual(1);
    expect(card.spill, `card ${card.id} spills past its right edge`).toBeLessThanOrEqual(1);
  }

  const continuingOverflow = await page
    .locator(".day")
    .nth(1)
    .locator(".continuing-card")
    .evaluate((card) => {
      const title = card.querySelector(".continuing-title")!;
      const cardBox = card.getBoundingClientRect();
      return {
        clipped: card.scrollWidth - card.clientWidth,
        wordOverflow: title.scrollWidth - title.clientWidth,
        spill: title.getBoundingClientRect().right - cardBox.right,
      };
    });
  expect(continuingOverflow.clipped).toBeLessThanOrEqual(1);
  expect(continuingOverflow.wordOverflow).toBeLessThanOrEqual(1);
  expect(continuingOverflow.spill).toBeLessThanOrEqual(1);

  const page_ = await page.evaluate(() => ({
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(page_.pageWidth).toBeLessThanOrEqual(page_.viewportWidth);
});

function helsinkiToday(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Helsinki",
  }).format(new Date());
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const at = new Date(Date.UTC(year, month - 1, day));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

async function createBatch(
  page: Page,
  date: string,
  slot: "lunch" | "dinner",
  recipeId: number,
): Promise<number> {
  const response = await page.request.post("/api/batches", {
    data: { date, slot, recipeId, multiplier: 1 },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
}

async function setCoverage(
  page: Page,
  id: number,
  occurrences: Array<[string, "lunch" | "dinner"]>,
): Promise<void> {
  const response = await page.request.patch(`/api/batches/${id}`, {
    data: {
      occurrences: occurrences.map(([date, slot]) => ({ date, slot })),
    },
  });
  expect(response.status()).toBe(204);
}
