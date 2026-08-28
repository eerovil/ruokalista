/**
 * Reading a recipe off a web address (#192), without a network and without a
 * model.
 *
 * Two halves are worth checking here rather than through a browser. The address
 * guard is the one that must not be subtly wrong in the permissive direction —
 * the same reasoning `dev/check-local-origin.ts` records — and the extraction is
 * the part that decides what a household ends up with, tested against the
 * shapes real recipe pages use rather than one tidy fixture.
 *
 *   ./scripts/node.sh npm run check
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchRecipePage,
  MAX_PAGE_BYTES,
  normaliseRecipeUrl,
  PageRefused,
  readRecipeFromPage,
  visibleText,
  type PageFetcher,
} from "../src/recipe-fetch.ts";

// ------------------------------------------------------------- the address

test("an ordinary recipe address is accepted, with the scheme filled in", () => {
  assert.equal(
    normaliseRecipeUrl("https://kotikokki.example/resepti/uunikaali").toString(),
    "https://kotikokki.example/resepti/uunikaali",
  );
  assert.equal(
    normaliseRecipeUrl("  kotikokki.example/resepti  ").toString(),
    "https://kotikokki.example/resepti",
  );
  // The fragment is the browser's business and never travels in a request.
  assert.equal(
    normaliseRecipeUrl("https://kotikokki.example/r#ainekset").toString(),
    "https://kotikokki.example/r",
  );
});

test("an address that is not a public web page is refused", () => {
  const refused = [
    "",
    "   ",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<p>hi</p>",
    "ftp://kotikokki.example/resepti",
    // Credentials in an address are how a fetch gets aimed somewhere it should
    // not go, and no recipe page needs them.
    "https://user:secret@kotikokki.example/resepti",
    // Anything addressed by number rather than by name.
    "http://127.0.0.1:8787/intake",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/",
    "http://10.0.0.7/",
    "http://[::1]/",
    "http://[fd00::1]/",
    // Names that resolve inside a network rather than on the web.
    "http://localhost:8787/intake",
    "http://wrangler.localhost/",
    "http://nas.local/reseptit",
    "http://db.internal/",
    "http://printer.home.arpa/",
    "http://intranet/",
  ];

  for (const address of refused) {
    assert.throws(
      () => normaliseRecipeUrl(address),
      (error: unknown) =>
        error instanceof PageRefused && error.reason === "invalid_url",
      address,
    );
  }
});

// ------------------------------------------------------------- the fetching

/** A stand-in `fetch` answering a fixed script of responses per address. */
function fetcherFor(pages: Record<string, Response>): PageFetcher {
  return (url) => {
    const response = pages[url];
    if (response === undefined) {
      return Promise.reject(new Error(`nothing at ${url}`));
    }
    return Promise.resolve(response);
  };
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    ...init,
  });
}

const JSON_LD_PAGE = `<!doctype html>
<html lang="fi"><head><title>Uunikaali</title>
<script type="application/ld+json">
${JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", name: "Kotikokki" },
    {
      "@type": ["Recipe", "Thing"],
      name: "Uunikaali",
      description: "Halpa ja hyv&auml; arkiruoka.",
      recipeYield: ["4 annosta", "4"],
      recipeIngredient: [
        "1 kg valkokaalia",
        "2 dl riisi&auml;",
        "<b>1 tl</b> suolaa",
      ],
      recipeInstructions: [
        {
          "@type": "HowToSection",
          name: "Kastike",
          itemListElement: [
            { "@type": "HowToStep", text: "Kiehauta maito." },
            { "@type": "HowToStep", text: "Lis&auml;&auml; jauhot." },
          ],
        },
        { "@type": "HowToStep", text: "<p>Paista uunissa.</p>" },
      ],
    },
  ],
})}
</script>
</head><body><nav>Etusivu</nav><p>Kommentit</p></body></html>`;

test("a page's structured recipe becomes the text the model is given", async () => {
  const page = await fetchRecipePage(
    "https://kotikokki.example/uunikaali",
    fetcherFor({ "https://kotikokki.example/uunikaali": htmlResponse(JSON_LD_PAGE) }),
  );

  assert.equal(page.structured, true);
  assert.equal(page.title, "Uunikaali");
  assert.equal(page.url, "https://kotikokki.example/uunikaali");
  assert.equal(
    page.sourceText,
    [
      "Uunikaali",
      "",
      "Halpa ja hyvä arkiruoka.",
      "",
      "Annoksia: 4 annosta",
      "",
      "Ainekset:",
      "1 kg valkokaalia",
      "2 dl riisiä",
      "1 tl suolaa",
      "",
      "Valmistus:",
      // A section's name titles what follows and is not numbered with it: that
      // heading is exactly the wording the model reads as a part of the dish.
      "Kastike",
      "2. Kiehauta maito.",
      "3. Lisää jauhot.",
      "4. Paista uunissa.",
    ].join("\n"),
  );
});

test("a page with no structured recipe gives up its visible text instead", () => {
  const markup = `<!doctype html><html><head>
    <style>.x{color:red}</style><script>var a = 1;</script></head>
    <body><nav>Etusivu | Reseptit | Haku</nav>
    <h1>Kaalilaatikko</h1>
    <ul><li>1 kg kaalia</li><li>400 g jauhelihaa</li></ul>
    <p>Kuullota kaali pannulla. Sekoita jauheliha joukkoon ja mausta.
       Paista uunissa 200 asteessa noin tunnin ajan, kunnes pinta on ruskea.</p>
    <p>Tarjoile puolukkahillon kanssa. Laatikko s&auml;ilyy j&auml;&auml;kaapissa
       muutaman p&auml;iv&auml;n ja maistuu l&auml;mmitettyn&auml;kin hyv&auml;lt&auml;.</p>
    <footer>&copy; Kotikokki</footer></body></html>`;

  const page = readRecipeFromPage(markup, "https://kotikokki.example/kaali");

  assert.equal(page.structured, false);
  assert.equal(page.title, null);
  assert.ok(page.sourceText.startsWith("Kaalilaatikko"), page.sourceText);
  assert.ok(page.sourceText.includes("400 g jauhelihaa"));
  assert.ok(page.sourceText.includes("säilyy jääkaapissa"));
  // The chrome around the recipe is not part of it, and a model handed a
  // navigation menu will read one as an ingredient sooner or later.
  assert.ok(!page.sourceText.includes("Etusivu"));
  assert.ok(!page.sourceText.includes("var a = 1"));
  assert.ok(!page.sourceText.includes("color:red"));
});

test("an incomplete structured recipe falls back to the visible recipe", () => {
  const markup = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Kaalilaatikko",
      description: "Helppo arkiruoka.",
      recipeYield: "4 annosta",
    })}</script></head><body>
    <main><h1>Kaalilaatikko</h1>
    <h2>Ainekset</h2>
    <ul><li>1 kg valkokaalia</li><li>400 g jauhelihaa</li><li>2 dl riisiä</li></ul>
    <h2>Valmistus</h2>
    <p>Suikaloi kaali ja kuullota se pannulla. Ruskista jauheliha ja keitä riisi.</p>
    <p>Sekoita kaikki vuokaan, mausta huolellisesti ja paista 200 asteessa noin
       tunnin ajan. Tarjoile puolukkahillon kanssa lämpimänä.</p></main>
    </body></html>`;

  const page = readRecipeFromPage(markup, "https://kotikokki.example/kaali");

  assert.equal(page.structured, false);
  assert.equal(page.title, null);
  assert.ok(page.sourceText.includes("1 kg valkokaalia"), page.sourceText);
  assert.ok(page.sourceText.includes("Ruskista jauheliha"), page.sourceText);
});

test("a page that yields almost nothing is a refusal, not an empty import", () => {
  assert.throws(
    () => readRecipeFromPage("<html><body><p>Ei mitään.</p></body></html>", "https://x.example/"),
    (error: unknown) => error instanceof PageRefused && error.reason === "no_recipe",
  );
});

test("one broken JSON-LD block does not lose the good one on the same page", () => {
  const markup = `<html><head>
    <script type="application/ld+json">{ not json at all }</script>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Puuro",
      recipeIngredient: ["1 dl kauraa", "3 dl vettä"],
      recipeInstructions: "Keitä puuroksi.",
    })}</script>
    </head><body></body></html>`;

  const page = readRecipeFromPage(markup, "https://x.example/puuro");
  assert.equal(page.structured, true);
  assert.equal(page.title, "Puuro");
  assert.ok(page.sourceText.includes("1 dl kauraa"));
  assert.ok(page.sourceText.includes("1. Keitä puuroksi."));
});

test("a redirect is followed, and every hop is checked like the first", async () => {
  const redirect = (to: string) =>
    new Response(null, { status: 301, headers: { Location: to } });

  const page = await fetchRecipePage(
    "https://kotikokki.example/vanha",
    fetcherFor({
      "https://kotikokki.example/vanha": redirect("/uunikaali"),
      "https://kotikokki.example/uunikaali": htmlResponse(JSON_LD_PAGE),
    }),
  );
  assert.equal(page.url, "https://kotikokki.example/uunikaali");

  // The whole point of following redirects by hand: a public address that
  // bounces somewhere private is refused at the bounce.
  await assert.rejects(
    fetchRecipePage(
      "https://kotikokki.example/vanha",
      fetcherFor({
        "https://kotikokki.example/vanha": redirect("http://169.254.169.254/"),
      }),
    ),
    (error: unknown) =>
      error instanceof PageRefused && error.reason === "invalid_url",
  );
});

test("something that is not a web page is refused before it is read", async () => {
  await assert.rejects(
    fetchRecipePage(
      "https://kotikokki.example/resepti.pdf",
      fetcherFor({
        "https://kotikokki.example/resepti.pdf": new Response("%PDF-1.7", {
          headers: { "Content-Type": "application/pdf" },
        }),
      }),
    ),
    (error: unknown) => error instanceof PageRefused && error.reason === "not_a_page",
  );
});

test("a page that answers with an error is not read as a recipe", async () => {
  await assert.rejects(
    fetchRecipePage(
      "https://kotikokki.example/poistettu",
      fetcherFor({
        "https://kotikokki.example/poistettu": htmlResponse("<p>Ei löydy</p>", {
          status: 404,
        }),
      }),
    ),
    (error: unknown) => error instanceof PageRefused && error.reason === "unreachable",
  );
});

test("a body that keeps arriving is cut off rather than read whole", async () => {
  const chunk = new TextEncoder().encode("x".repeat(100_000));
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
  });

  await assert.rejects(
    fetchRecipePage(
      "https://kotikokki.example/valtava",
      fetcherFor({
        "https://kotikokki.example/valtava": new Response(endless, {
          headers: {
            "Content-Type": "text/html",
            // A Content-Length is a claim; the cap is counted from the bytes.
            "Content-Length": "42",
          },
        }),
      }),
    ),
    (error: unknown) => error instanceof PageRefused && error.reason === "too_large",
  );

  assert.ok(MAX_PAGE_BYTES > 0);
});

test("a page that cannot be reached at all reads as unreachable", async () => {
  await assert.rejects(
    fetchRecipePage("https://kotikokki.example/pois", fetcherFor({})),
    (error: unknown) => error instanceof PageRefused && error.reason === "unreachable",
  );
});

test("entities and inline markup do not survive into the recipe text", () => {
  assert.equal(
    visibleText("<p>1&nbsp;&frac12; dl vett&auml; &amp; 200&deg;C</p>"),
    "1 ½ dl vettä & 200°C",
  );
  // An entity nobody decodes is left as it stands rather than guessed at.
  assert.equal(visibleText("<p>&nosuchthing; kaalia</p>"), "&nosuchthing; kaalia");
});
