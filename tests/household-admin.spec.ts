import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

import { reseed } from "./support/seed";
import { sessionCookie } from "./support/session";

/**
 * The admin household tool (#127). Two things are being proved at once here:
 * that an admin really can see and edit across household boundaries, which
 * nothing else in this app may do, and that the boundary itself is untouched —
 * an ordinary member is told every one of these routes is not there.
 *
 * The seed's household 2 (Naapuri) is what the crossing is proved against: the
 * admin is member 3, who belongs to household 1 and has no business in
 * household 2 anywhere else in the product.
 */

test.beforeAll(reseed);

async function signIn(page: Page, memberId: number): Promise<void> {
  await page.context().addCookies([sessionCookie(memberId)]);
}

function cookieHeader(memberId: number): string {
  const cookie = sessionCookie(memberId);
  return `${cookie.name}=${cookie.value}`;
}

test("the panel offers the household tool", async ({ page }) => {
  await signIn(page, 3);
  await page.goto("/admin");

  const link = page.getByRole("link", { name: /Householdit/ });
  await expect(link).toHaveAttribute("href", "/admin/households");
  await link.click();

  await expect(page.getByRole("heading", { name: "Householdit" })).toBeVisible();
});

test("an admin sees every household, including one they are not in", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/households");

  await expect(page.getByRole("link", { name: /Koti/ })).toHaveAttribute(
    "href",
    "/admin/households/1",
  );
  await expect(page.getByRole("link", { name: /Naapuri/ })).toHaveAttribute(
    "href",
    "/admin/households/2",
  );
  await expect(page.getByRole("link", { name: /Koti/ })).toContainText("2 jäsentä");
  await expect(page.getByRole("link", { name: /Naapuri/ })).toContainText("1 jäsen");
});

test("an admin opens another household and sees its members", async ({ page }) => {
  await signIn(page, 3);
  await page.goto("/admin/households/2");

  await expect(page.getByRole("heading", { name: "Naapuri" })).toBeVisible();
  await expect(page.locator("details.rename")).toHaveCount(1);
  await expect(page.locator("details.rename")).toContainText("Naapuri");
});

test("an admin creates a household and lands on it", async ({ page }) => {
  await signIn(page, 3);
  await page.goto("/admin/households");

  await page.locator("#new-household").fill("Mökki");
  await page.getByRole("button", { name: "Luo talous" }).click();

  await expect(page.getByRole("heading", { name: "Mökki" })).toBeVisible();
  await expect(page.getByText("Taloudessa ei ole jäseniä")).toBeVisible();
  expect(page.url()).toMatch(/\/admin\/households\/\d+$/);
});

test("a household with no name is refused, and the screen keeps what was typed", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/households");

  await page.locator("#new-household").fill("   ");
  await page.getByRole("button", { name: "Luo talous" }).click();

  await expect(page.locator(".refused")).toContainText("Taloudella pitää olla nimi");
  await expect(page.getByRole("heading", { name: "Householdit" })).toBeVisible();
  await expect(page.locator("#new-household")).toHaveValue("   ");
});

test("an admin renames another household", async ({ page }) => {
  await signIn(page, 3);
  await page.goto("/admin/households/2");

  await page.locator("#household-name").fill("Naapurin talous");
  await page.getByRole("button", { name: "Tallenna nimi" }).click();

  await expect(
    page.getByRole("heading", { name: "Naapurin talous" }),
  ).toBeVisible();

  // Put it back so the rest of this file reads the seeded name.
  await page.locator("#household-name").fill("Naapuri");
  await page.getByRole("button", { name: "Tallenna nimi" }).click();
  await expect(page.getByRole("heading", { name: "Naapuri" })).toBeVisible();
});

test("an admin adds, edits and removes a member of another household", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/households/2");

  await page.locator("#add-name").fill("Vieras");
  await page.locator("#add-email").fill("vieras@example.com");
  await page.locator("#add-sub").fill("sub-vieras");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();

  const row = page.locator("details.rename").filter({ hasText: "Vieras" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("vieras@example.com");

  const memberId = await memberIdOf(page, "Vieras");

  await row.locator("summary").click();
  await page.locator(`#member-${memberId}-name`).fill("Vieras Vieraskoski");
  await page.locator(`#member-${memberId}-email`).fill("uusi@example.com");
  await page.locator(`#member-${memberId}-sub`).fill("sub-vieras-uusi");
  await row.getByRole("button", { name: "Tallenna muutokset" }).click();

  const edited = page.locator("details.rename").filter({ hasText: "Vieraskoski" });
  await expect(edited).toContainText("uusi@example.com");
  await edited.locator("summary").click();
  await expect(page.locator(`#member-${memberId}-sub`)).toHaveValue(
    "sub-vieras-uusi",
  );

  await edited.getByRole("button", { name: "Poista taloudesta" }).click();
  await expect(
    page.locator("details.rename").filter({ hasText: "Vieraskoski" }),
  ).toHaveCount(0);
  await expect(page.locator("details.rename")).toHaveCount(1);
});

test("a member who has made things is removed, and what they made stays", async ({
  page,
  request,
}) => {
  // Seed member 2 owns household 2's ingredient. The first attempt at this
  // screen refused to remove anybody in that position, which is almost every
  // real member — and #127's only move is a removal followed by an addition, so
  // that refusal blocked the move too. Removal now takes the household away and
  // leaves the history where it is.
  await signIn(page, 3);
  await page.goto("/admin/households/2");

  const row = page.locator("details.rename").filter({ hasText: "Naapuri" });
  await row.locator("summary").click();
  await row.getByRole("button", { name: "Poista taloudesta" }).click();

  await expect(page.locator(".refused")).toHaveCount(0);
  await expect(page.getByText("Taloudessa ei ole jäseniä")).toBeVisible();
  // The household survives its last member leaving.
  await expect(page.getByRole("heading", { name: "Naapuri" })).toBeVisible();
});

test("a removed member's own session no longer opens the household", async ({
  request,
}) => {
  // Not only the Google match: a cookie already in somebody's browser names a
  // member id, so the id lookup has to refuse them too.
  const week = await request.get("/", {
    headers: { Cookie: cookieHeader(2) },
    maxRedirects: 0,
  });
  expect(week.status()).toBe(302);
  expect(week.headers()["location"]).toBe("/signin");

  const api = await request.get("/api/ingredients", {
    headers: { Cookie: cookieHeader(2) },
  });
  expect(api.status()).toBe(401);
});

test("the removed member's Google sub is free for another household", async ({
  page,
}) => {
  // The second half of a move. Their old sub was UNIQUE across the table, so
  // this is the check that removal really handed it back.
  await signIn(page, 3);
  await page.goto("/admin/households/1");
  await page.locator("#add-name").fill("Naapuri");
  await page.locator("#add-sub").fill("dev-seed-naapuri");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();

  await expect(page.locator(".refused")).toHaveCount(0);
  const moved = page.locator("details.rename").filter({ hasText: "Naapuri" });
  await expect(moved).toHaveCount(1);

  // A new row in the new household, not the old one reparented.
  const memberId = await memberIdOf(page, "Naapuri");
  expect(memberId).toBeGreaterThan(3);

  // And they can sign in, into household 1 now.
  await moved.locator("summary").click();
  await expect(page.locator(`#member-${memberId}-sub`)).toHaveValue(
    "dev-seed-naapuri",
  );
});

test("the sub a removed row parks on cannot be typed in", async ({ page }) => {
  // The parked value is not ASCII, so it is not a Google sub, so the form will
  // not take it — which is the only way a live member could land on top of a
  // removed one. See `src/google.ts::isGoogleSub`.
  await signIn(page, 3);
  await page.goto("/admin/households/1");
  await page.locator("#add-name").fill("Väärennös");
  await page.locator("#add-sub").fill("—removed:2");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();

  await expect(page.locator(".refused")).toContainText(
    "ei ole kelvollinen Google-tunniste",
  );
});

test("a Google sub that merely looks like a tombstone is an ordinary sub", async ({
  page,
}) => {
  // The other half of the rule, and the bug it was written for. This screen
  // used to reserve `removed:<id>` for removed rows on the belief that Google
  // never issues a sub in that shape — Google promises no such thing, so
  // somebody whose real account id is `removed:2` was locked out of the app by
  // a naming convention. They are an ordinary member now.
  await signIn(page, 3);
  await page.goto("/admin/households/1");
  await page.locator("#add-name").fill("Tuomas");
  await page.locator("#add-sub").fill("removed:2");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();

  await expect(page.locator(".refused")).toHaveCount(0);
  const row = page.locator("details.rename").filter({ hasText: "Tuomas" });
  await expect(row).toHaveCount(1);

  const memberId = await memberIdOf(page, "Tuomas");
  await row.locator("summary").click();
  await expect(page.locator(`#member-${memberId}-sub`)).toHaveValue("removed:2");

  // And they are not mistaken for a parked row: they can be removed, which
  // parks them somewhere else again, and household 1 is as it was.
  await row.getByRole("button", { name: "Poista taloudesta" }).click();
  await expect(page.locator(".refused")).toHaveCount(0);
  await expect(
    page.locator("details.rename").filter({ hasText: "Tuomas" }),
  ).toHaveCount(0);
});

test("an admin's own row cannot be removed here", async ({ page }) => {
  await signIn(page, 3);
  await page.goto("/admin/households/1");

  const row = page.locator("details.rename").filter({ hasText: "Ylläpitäjä" });
  await row.locator("summary").click();
  await row.getByRole("button", { name: "Poista taloudesta" }).click();

  await expect(page.locator(".refused")).toContainText("on ylläpitäjä");
  await expect(
    page.locator("details.rename").filter({ hasText: "Ylläpitäjä" }),
  ).toHaveCount(1);
});

test("an admin's Google sub cannot be repointed at another account", async ({
  page,
}) => {
  // The privilege transfer this screen must not have. Sign-in matches on
  // google_sub and reads is_admin off that same row, so changing an admin's sub
  // would hand admin to whoever owns the new one — without touching a field
  // called is_admin, and without scripts/set-admin.sh.
  await signIn(page, 3);
  await page.goto("/admin/households/1");

  const row = page.locator("details.rename").filter({ hasText: "Ylläpitäjä" });
  await row.locator("summary").click();
  await page.locator("#member-3-sub").fill("sub-kaapattu");
  await row.getByRole("button", { name: "Tallenna muutokset" }).click();

  await expect(page.locator(".refused")).toContainText(
    "Google-tunnistettaan ei voi vaihtaa",
  );

  // And the row still points where it did.
  await page.goto("/admin/households/1");
  await page
    .locator("details.rename")
    .filter({ hasText: "Ylläpitäjä" })
    .locator("summary")
    .click();
  await expect(page.locator("#member-3-sub")).toHaveValue("dev-seed-admin");
});

test("an admin's name and email are still editable", async ({ page }) => {
  // The guard is on identity, not on the row. Correcting a typo in an admin's
  // name is exactly the job this screen exists for.
  await signIn(page, 3);
  await page.goto("/admin/households/1");

  const row = page.locator("details.rename").filter({ hasText: "Ylläpitäjä" });
  await row.locator("summary").click();
  await page.locator("#member-3-name").fill("Ylläpitäjä Ylläkoski");
  await page.locator("#member-3-email").fill("yllapitaja@example.com");
  await row.getByRole("button", { name: "Tallenna muutokset" }).click();

  const renamed = page
    .locator("details.rename")
    .filter({ hasText: "Ylläkoski" });
  await expect(renamed).toContainText("yllapitaja@example.com");
  await expect(page.locator(".refused")).toHaveCount(0);

  // Put the seeded name back for the tests that follow.
  await renamed.locator("summary").click();
  await page.locator("#member-3-name").fill("Ylläpitäjä");
  await page.locator("#member-3-email").fill("");
  await renamed.getByRole("button", { name: "Tallenna muutokset" }).click();
  await expect(
    page.locator("details.rename").filter({ hasText: "Ylläpitäjä" }),
  ).toContainText("ei sähköpostia");
});

test("another admin's row is refused too, through the routes themselves", async ({
  page,
  request,
}) => {
  // The guard reads the row's own is_admin, not "is this me". Proving that
  // needs a second admin, and this screen deliberately cannot make one — so the
  // test promotes a member the way an operator would, straight in the database,
  // and then tries both writes against somebody who is not the caller.
  await signIn(page, 3);
  await page.goto("/admin/households/2");
  await page.locator("#add-name").fill("Toinen ylläpitäjä");
  await page.locator("#add-sub").fill("sub-toinen-yllapitaja");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();

  const memberId = await memberIdOf(page, "Toinen ylläpitäjä");
  promoteToAdmin("sub-toinen-yllapitaja");

  const repointed = await request.post(
    `/admin/households/2/members/${memberId}`,
    {
      headers: { Cookie: cookieHeader(3) },
      maxRedirects: 0,
      form: {
        display_name: "Toinen ylläpitäjä",
        email: "",
        google_sub: "sub-kaapattu",
      },
    },
  );
  expect(repointed.status()).toBe(400);
  expect(await repointed.text()).toContain("ei voi vaihtaa");

  const removed = await request.post(
    `/admin/households/2/members/${memberId}/delete`,
    { headers: { Cookie: cookieHeader(3) }, maxRedirects: 0 },
  );
  expect(removed.status()).toBe(400);
  expect(await removed.text()).toContain("ei voi poistaa");

  // Both refused, so the row is still there and still points where it did.
  await page.goto("/admin/households/2");
  const row = page
    .locator("details.rename")
    .filter({ hasText: "Toinen ylläpitäjä" });
  await expect(row).toHaveCount(1);
  await row.locator("summary").click();
  await expect(page.locator(`#member-${memberId}-sub`)).toHaveValue(
    "sub-toinen-yllapitaja",
  );

  // Demote and remove, so household 2 is back to one member.
  demoteFromAdmin("sub-toinen-yllapitaja");
  const gone = await request.post(
    `/admin/households/2/members/${memberId}/delete`,
    { headers: { Cookie: cookieHeader(3) }, maxRedirects: 0 },
  );
  expect(gone.status()).toBe(303);
});

test("a Google sub already in use is refused, and says where it is", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/households/2");

  await page.locator("#add-name").fill("Kaksoisolento");
  await page.locator("#add-sub").fill("dev-seed-koti");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();

  await expect(page.locator(".refused")).toContainText("jo taloudessa Koti");
  await expect(page.locator("#add-name")).toHaveValue("Kaksoisolento");
  await expect(page.locator("#add-sub")).toHaveValue("dev-seed-koti");
});

test("a member with no name and a member with no sub are both refused", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/households/2");

  await page.locator("#add-sub").fill("sub-nimeton");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();
  await expect(page.locator(".refused")).toContainText("pitää olla nimi");

  await page.goto("/admin/households/2");
  await page.locator("#add-name").fill("Tunnisteeton");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();
  await expect(page.locator(".refused")).toContainText("Google-tunniste");

  // Neither refusal let a half-filled member through. Household 2 is empty by
  // this point in the file — its one seeded member was removed above.
  await expect(page.locator("details.rename")).toHaveCount(0);
});

test("the screen offers no transfer, no household delete and no admin control", async ({
  page,
}) => {
  await signIn(page, 3);
  await page.goto("/admin/households/1");
  await page.locator("details.rename").first().locator("summary").click();

  const body = await page.locator("main").innerHTML();
  expect(body).not.toContain("is_admin");
  expect(body).not.toContain("isAdmin");
  expect(body).not.toContain("household_id");
  await expect(page.getByRole("button", { name: /Poista talous/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Siirrä/ })).toHaveCount(0);
});

test("nothing the form says can create an admin", async ({ page, request }) => {
  // The three editable fields are named one by one in the UPDATE, so an extra
  // form field is just more of the request. Proved end to end: the member this
  // creates is asked for the admin panel and told it is not there.
  await signIn(page, 3);

  const created = await request.post("/admin/households/2/members", {
    headers: { Cookie: cookieHeader(3) },
    maxRedirects: 0,
    form: {
      display_name: "Salakavala",
      email: "",
      google_sub: "sub-salakavala",
      is_admin: "1",
      isAdmin: "true",
      household_id: "1",
    },
  });
  expect(created.status()).toBe(303);

  await page.goto("/admin/households/2");
  const memberId = await memberIdOf(page, "Salakavala");

  // Still in household 2, whatever the form claimed.
  await expect(
    page.locator("details.rename").filter({ hasText: "Salakavala" }),
  ).toHaveCount(1);

  const asThem = await request.get("/admin", {
    headers: { Cookie: cookieHeader(memberId) },
    maxRedirects: 0,
  });
  expect(asThem.status()).toBe(404);

  const edited = await request.post(
    `/admin/households/2/members/${memberId}`,
    {
      headers: { Cookie: cookieHeader(3) },
      maxRedirects: 0,
      form: {
        display_name: "Salakavala",
        email: "",
        google_sub: "sub-salakavala",
        is_admin: "1",
      },
    },
  );
  expect(edited.status()).toBe(303);

  const stillNot = await request.get("/admin", {
    headers: { Cookie: cookieHeader(memberId) },
    maxRedirects: 0,
  });
  expect(stillNot.status()).toBe(404);
});

test("a household that is not there is a 404, not a blank screen", async ({
  page,
}) => {
  await signIn(page, 3);
  const response = await page.goto("/admin/households/9999");

  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Ei löytynyt" })).toBeVisible();
});

test("an ordinary member is refused every household route", async ({ request }) => {
  // The link not rendering is tidiness. These are the routes, asked directly.
  const screens = ["/admin/households", "/admin/households/1"];
  for (const path of screens) {
    const response = await request.get(path, {
      headers: { Cookie: cookieHeader(1) },
      maxRedirects: 0,
    });
    expect(response.status(), path).toBe(404);
    expect(await response.text(), path).toContain("Tätä sivua ei ole.");
  }

  const posts = [
    "/admin/households",
    "/admin/households/1/name",
    "/admin/households/1/members",
    "/admin/households/1/members/3",
    "/admin/households/1/members/3/delete",
  ];
  for (const path of posts) {
    const response = await request.post(path, {
      headers: { Cookie: cookieHeader(1) },
      maxRedirects: 0,
      form: { name: "Kaappaus", display_name: "Kaappaus", google_sub: "x" },
    });
    expect(response.status(), path).toBe(404);
  }

  // And none of it happened.
  const asAdmin = await request.get("/admin/households", {
    headers: { Cookie: cookieHeader(3) },
  });
  const text = await asAdmin.text();
  expect(text).not.toContain("Kaappaus");
});

test("a signed-out browser is sent to sign in, not to the households", async ({
  request,
}) => {
  const screen = await request.get("/admin/households", { maxRedirects: 0 });
  expect(screen.status()).toBe(302);
  expect(screen.headers()["location"]).toBe("/signin");

  const posted = await request.post("/admin/households", {
    maxRedirects: 0,
    form: { name: "Ei kirjautunut" },
  });
  expect(posted.status()).toBe(302);
  expect(posted.headers()["location"]).toBe("/signin");
});

test("the ordinary product still shows nobody another household", async ({
  page,
}) => {
  // The whole point of confining the crossing: member 1 sees household 1's
  // recipes only, exactly as before. The ingredient dictionary is shared since
  // #143 and is no longer the thing to measure this with — a recipe is.
  await signIn(page, 1);
  await page.goto("/recipes");

  await expect(page.getByText("Naapurin uunikala")).toHaveCount(0);
  await expect(page.getByText("Kaalilaatikko")).toBeVisible();
});

/**
 * The acceptance criterion the first attempt missed, end to end, and last in
 * the file because it removes the member almost every other spec signs in as.
 *
 * Member 1 is as established as this seed gets: household 1's ingredients,
 * recipes and planned batches are all theirs. Removing them has to leave every
 * one of those where it is — the recipe list even prints their name, because it
 * joins `member` on `recipe.created_by` — while taking away the household.
 */
test("an established member is removed, keeps their history, and moves house", async ({
  page,
  request,
}) => {
  // A planned batch of their own, so the removal crosses all four tables that
  // record who made a row.
  const planned = await request.post("/api/batches", {
    headers: { Cookie: cookieHeader(1) },
    data: { recipeId: 1, date: "2026-11-02", slot: "lunch", portions: 4 },
  });
  expect(planned.status()).toBe(201);

  // Before: their name is on the recipe list.
  await signIn(page, 3);
  await page.goto("/recipes");
  await expect(page.getByText("Kaalilaatikko")).toBeVisible();
  await expect(page.locator(".recipes").first()).toContainText("Eero");

  await page.goto("/admin/households/1");
  const row = page.locator("details.rename").filter({ hasText: "Eero" });
  await row.locator("summary").click();
  await row.getByRole("button", { name: "Poista taloudesta" }).click();

  // Removed, with no refusal and no member row left for them.
  await expect(page.locator(".refused")).toHaveCount(0);
  await expect(
    page.locator("details.rename").filter({ hasText: "Eero" }),
  ).toHaveCount(0);

  // The household's content is untouched, and still attributed to them — which
  // a DELETE could not have managed, because that join would have dropped the
  // recipe off the list entirely.
  await page.goto("/recipes");
  await expect(page.getByText("Kaalilaatikko")).toBeVisible();
  await expect(page.locator(".recipes").first()).toContainText("Eero");

  await page.goto("/ingredients");
  await expect(page.getByText("valkokaali")).toBeVisible();

  const menu = await request.get("/api/menu?from=2026-11-02&to=2026-11-02", {
    headers: { Cookie: cookieHeader(3) },
  });
  expect(menu.status()).toBe(200);
  expect(JSON.stringify(await menu.json())).toContain("Kaalilaatikko");

  // They, however, are out — by the cookie they already had, not only by Google.
  const week = await request.get("/", {
    headers: { Cookie: cookieHeader(1) },
    maxRedirects: 0,
  });
  expect(week.status()).toBe(302);
  expect(week.headers()["location"]).toBe("/signin");

  const theirIngredients = await request.get("/api/ingredients", {
    headers: { Cookie: cookieHeader(1) },
  });
  expect(theirIngredients.status()).toBe(401);

  // And they cannot sign back in through the old row either — not merely carry
  // on with a cookie they already had. The removed row is off the development
  // sign-in list, and asking for it by id is refused with no cookie issued,
  // which is the same answer a member who never existed gets.
  await page.goto("/signin");
  await expect(page.getByRole("button", { name: "Eero" })).toHaveCount(0);

  const backIn = await request.post("/auth/dev-signin", {
    form: { memberId: "1" },
    maxRedirects: 0,
  });
  expect(backIn.status()).toBe(400);
  expect(backIn.headers()["set-cookie"]).toBeUndefined();

  // And the other half of the move: the same Google account, in the other
  // household, as a new row.
  await page.goto("/admin/households/2");
  await page.locator("#add-name").fill("Eero");
  await page.locator("#add-sub").fill("dev-seed-koti");
  await page.getByRole("button", { name: "Lisää jäsen" }).click();
  await expect(page.locator(".refused")).toHaveCount(0);

  const movedId = await memberIdOf(page, "Eero");
  expect(movedId).not.toBe(1);

  // Signed in there, they see household 2's recipes and none of household 1's.
  // The ingredient dictionary is global since #143, so the recipe list is what
  // still answers "which household am I in".
  const nowNeighbour = await request.get("/api/recipes", {
    headers: { Cookie: cookieHeader(movedId) },
  });
  expect(nowNeighbour.status()).toBe(200);
  const titles = JSON.stringify(await nowNeighbour.json());
  expect(titles).toContain("Naapurin uunikala");
  expect(titles).not.toContain("Kaalilaatikko");
});

/**
 * Admin is granted the way `scripts/set-admin.sh` grants it — against the
 * database, never through the app. A test that needs a second admin has to go
 * the same way, which is itself part of what is being proved.
 */
function setAdmin(googleSub: string, on: boolean): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "ruokalista",
      "--local",
      "--command",
      `UPDATE member SET is_admin = ${on ? 1 : 0} WHERE google_sub = '${googleSub}'`,
    ],
    { cwd: process.cwd(), stdio: "ignore" },
  );
}

function promoteToAdmin(googleSub: string): void {
  setAdmin(googleSub, true);
}

function demoteFromAdmin(googleSub: string): void {
  setAdmin(googleSub, false);
}

async function memberIdOf(page: Page, name: string): Promise<number> {
  const action = await page
    .locator("details.rename")
    .filter({ hasText: name })
    .locator("form.stacked")
    .getAttribute("action");

  const id = Number(action?.split("/").pop());
  expect(Number.isInteger(id), `no member row for ${name}`).toBe(true);
  return id;
}
