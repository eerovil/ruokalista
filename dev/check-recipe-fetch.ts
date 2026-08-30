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

import { MAX_IMAGE_BYTES } from "../src/image-bytes.ts";
import {
  fetchRecipeImage,
  fetchRecipePage,
  MAX_PAGE_BYTES,
  normaliseRecipeUrl,
  PageRefused,
  readRecipeFromPage,
  visibleText,
  type PageFetcher,
} from "../src/recipe-fetch.ts";
import { png } from "./support/images.ts";

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

test("a flat structured recipe keeps an explicit visible flavor outline", () => {
  const markup = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Välipalapatukat",
      description: "Valittavanasi on viisi erilaista makuvaihtoehtoa.",
      recipeIngredient: [
        "100 g pähkinöitä", "100 g taateleita", "1 rkl vettä",
        "15 g vadelmia", "1 tl lakritsijauhetta", "¾ tl kardemummaa",
        "4 rkl maapähkinävoita", "1 appelsiinin kuoriraaste",
      ],
      recipeInstructions: "Sekoita massaan haluamasi mausteet.",
    })}</script></head><body><main>
      <h1>Välipalapatukat</h1>
      <h2>Ainekset</h2>
      <h4>Perusmassa</h4>
      <p>100 g pähkinöitä</p><p>100 g taateleita</p><p>1 rkl vettä</p>
      <h4>Seuraavat makuvaihtoehdot mitoitettu 1 annokseen perusmassaa!</h4>
      <h4>Vadelma</h4><p>15 g vadelmia</p>
      <h4>Lakritsi</h4><p>1 tl lakritsijauhetta</p>
      <h4>Piparkakku</h4><p>¾ tl kardemummaa</p>
      <h4>Maapähkinä</h4><p>4 rkl maapähkinävoita</p>
      <h4>Appelsiini-kaakao</h4><p>1 appelsiinin kuoriraaste</p>
      <h2>Tarvikkeet</h2><p>leivinpaperi</p>
    </main></body></html>`;

  const page = readRecipeFromPage(
    markup,
    "https://www.kinuskikissa.fi/valipalapatukat",
  );

  assert.equal(page.structured, true);
  assert.match(page.sourceText, /Sivun näkyvä vaihtoehtorakenne:/);
  assert.match(
    page.sourceText,
    /Perusmassa[\s\S]*Vadelma[\s\S]*Lakritsi[\s\S]*Piparkakku[\s\S]*Maapähkinä[\s\S]*Appelsiini-kaakao/,
  );
  assert.ok(!page.sourceText.includes("Tarvikkeet"), page.sourceText);
});

test("ordinary component headings do not create a variant outline", () => {
  const markup = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Täytekakku",
      recipeIngredient: ["2 munaa", "2 dl kermaa", "100 g suklaata"],
      recipeInstructions: "Täytä ja kuorruta kakku.",
    })}</script></head><body><main>
      <h2>Pohja</h2><p>2 munaa</p>
      <h2>Täyte</h2><p>2 dl kermaa</p>
      <h2>Kuorrute</h2><p>100 g suklaata</p>
    </main></body></html>`;

  const page = readRecipeFromPage(markup, "https://leivonta.example/taytekakku");

  assert.equal(page.structured, true);
  assert.ok(!page.sourceText.includes("Sivun näkyvä vaihtoehtorakenne"));
});

test("headings hidden in page machinery do not create a variant outline", () => {
  const markup = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Marjapiirakka",
      recipeIngredient: ["2 dl jauhoja", "1 dl marjoja"],
      recipeInstructions: "Paista piirakka.",
    })}</script></head><body><main>
      <h1>Marjapiirakka</h1><p>2 dl jauhoja</p><p>1 dl marjoja</p>
      <template>
        <h2>Seuraavat vaihtoehdot</h2>
        <h2>Mustikka</h2><p>1 dl mustikoita</p>
        <h2>Vadelma</h2><p>1 dl vadelmia</p>
      </template>
      <script>
        var example = '<h2>Seuraavat makuvaihtoehdot</h2>' +
          '<h2>Omena</h2><h2>Päärynä</h2>';
      </script>
    </main></body></html>`;

  const page = readRecipeFromPage(markup, "https://leivonta.example/marjapiirakka");

  assert.equal(page.structured, true);
  assert.ok(!page.sourceText.includes("Sivun näkyvä vaihtoehtorakenne"));
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
    <p>Suikaloi kaali. Ruskista jauheliha ja keitä riisi. Sekoita kaikki vuokaan
       ja paista 200 asteessa tunnin ajan.</p></main>
    </body></html>`;

  const page = readRecipeFromPage(markup, "https://kotikokki.example/kaali");

  assert.equal(page.structured, false);
  assert.equal(page.title, null);
  assert.ok(page.sourceText.length < 200, page.sourceText);
  assert.ok(page.sourceText.includes("1 kg valkokaalia"), page.sourceText);
  assert.ok(page.sourceText.includes("Ruskista jauheliha"), page.sourceText);
});

test("structured ingredients and instructions do not hide a visible title", () => {
  const markup = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      recipeIngredient: ["2 munaa", "ripaus suolaa"],
      recipeInstructions: "Vatkaa munat ja paista pannulla.",
    })}</script></head><body><main>
    <h1>Munakas</h1><p>2 munaa</p><p>ripaus suolaa</p>
    <p>Vatkaa munat ja paista pannulla.</p>
    </main></body></html>`;

  const page = readRecipeFromPage(markup, "https://kotikokki.example/munakas");

  assert.equal(page.structured, false);
  assert.ok(page.sourceText.startsWith("Munakas"), page.sourceText);
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

// -------------------------------------------------------------- the picture

/**
 * Issue #205 brings the page's own photograph in with the recipe. Two things
 * are worth checking without a network: which address the page is read as
 * offering — where getting it wrong means a logo on somebody's recipe — and
 * that nothing about fetching it can fail an import that already worked.
 */

test("the Recipe node's own image is the first picture offered", () => {
  const markup = pageWith({
    "@type": "Recipe",
    name: "Uunikaali",
    image: "/kuvat/uunikaali.jpg",
    recipeIngredient: ["1 kg valkokaalia"],
    recipeInstructions: "Paista uunissa.",
  }, `<meta property="og:image" content="https://kotikokki.example/some-banner.png" />`);

  const page = readRecipeFromPage(markup, "https://kotikokki.example/uunikaali");

  assert.deepEqual(page.imageUrls, [
    // Resolved against the page it was found on, not handed on as it stood.
    "https://kotikokki.example/kuvat/uunikaali.jpg",
    "https://kotikokki.example/some-banner.png",
  ]);
});

test("image is understood as a list, and as an ImageObject", () => {
  const listed = readRecipeFromPage(
    pageWith({
      "@type": "Recipe",
      name: "Uunikaali",
      image: [
        "https://kuvat.example/1x1.jpg",
        { "@type": "ImageObject", url: "https://kuvat.example/4x3.jpg" },
        { "@type": "ImageObject", contentUrl: "https://kuvat.example/16x9.jpg" },
      ],
      recipeIngredient: ["1 kg valkokaalia"],
      recipeInstructions: "Paista uunissa.",
    }),
    "https://kotikokki.example/uunikaali",
  );

  // In the page's own order: the crops are the same photograph, and the first
  // one that turns out to be storable is the one that gets used.
  assert.deepEqual(listed.imageUrls, [
    "https://kuvat.example/1x1.jpg",
    "https://kuvat.example/4x3.jpg",
    "https://kuvat.example/16x9.jpg",
  ]);
});

test("og:image stands in when the recipe data names no picture", () => {
  const markup = pageWith({
    "@type": "Recipe",
    name: "Uunikaali",
    recipeIngredient: ["1 kg valkokaalia"],
    recipeInstructions: "Paista uunissa.",
  }, `<meta content="https://kotikokki.example/kuva.jpg" property="og:image">`);

  const page = readRecipeFromPage(markup, "https://kotikokki.example/uunikaali");
  assert.deepEqual(page.imageUrls, ["https://kotikokki.example/kuva.jpg"]);
});

test("a page with no recipe data on it offers no picture at all", () => {
  // The guard the issue asks for, and the reason og:image is a fallback rather
  // than a source: on a page that never said it had a recipe, the one picture
  // in the metadata is the site's masthead.
  const markup = `<!doctype html><html><head>
    <meta property="og:image" content="https://kotikokki.example/logo.png" />
    </head><body><main><h1>Kaalilaatikko</h1>
    <ul><li>1 kg kaalia</li><li>400 g jauhelihaa</li></ul>
    <p>Kuullota kaali pannulla. Sekoita jauheliha joukkoon ja mausta hyvin.
       Paista uunissa 200 asteessa noin tunnin ajan, kunnes pinta on ruskea.</p>
    <p>Tarjoile puolukkahillon kanssa ja säilytä loput jääkaapissa.</p>
    </main></body></html>`;

  const page = readRecipeFromPage(markup, "https://kotikokki.example/kaali");
  assert.equal(page.structured, false);
  assert.deepEqual(page.imageUrls, []);
});

test("a picture on a private name is dropped before it is ever dialled", () => {
  const page = readRecipeFromPage(
    pageWith({
      "@type": "Recipe",
      name: "Uunikaali",
      image: ["http://169.254.169.254/latest/meta-data", "http://localhost/kuva.png"],
      recipeIngredient: ["1 kg valkokaalia"],
      recipeInstructions: "Paista uunissa.",
    }),
    "https://kotikokki.example/uunikaali",
  );
  assert.deepEqual(page.imageUrls, []);
});

test("the first candidate that is really a picture is the one taken", async () => {
  const bytes = png(800, 600);
  const asked: string[] = [];

  const image = await fetchRecipeImage(
    [
      "https://kuvat.example/poissa.jpg",
      "https://kuvat.example/virhesivu.jpg",
      "https://kuvat.example/valtava.png",
      "https://kuvat.example/uunikaali.png",
    ],
    (url) => {
      asked.push(url);
      // Gone.
      if (url.endsWith("poissa.jpg")) return Promise.resolve(new Response("", { status: 404 }));
      // An error page served with a 200, which happens more than it should.
      if (url.endsWith("virhesivu.jpg")) {
        return Promise.resolve(new Response("<html>Hups</html>", {
          headers: { "Content-Type": "text/html" },
        }));
      }
      // A picture, but far too many pixels to store or to read on a phone.
      if (url.endsWith("valtava.png")) return Promise.resolve(imageResponse(png(4000, 3000)));
      return Promise.resolve(imageResponse(bytes));
    },
  );

  assert.notEqual(image, null);
  assert.equal(image?.contentType, "image/png");
  assert.equal(image?.url, "https://kuvat.example/uunikaali.png");
  assert.equal(image?.bytes.byteLength, bytes.byteLength);
  assert.equal(asked.length, 4);
});

test("bytes are believed from their signature, not from Content-Type", async () => {
  const claimed = await fetchRecipeImage(
    ["https://kuvat.example/valhe.jpg"],
    () =>
      Promise.resolve(
        new Response("kaikkea muuta kuin kuva", {
          headers: { "Content-Type": "image/jpeg" },
        }),
      ),
  );
  assert.equal(claimed, null);

  // And the other way round: a real picture served with no type at all is one.
  const untyped = await fetchRecipeImage(
    ["https://kuvat.example/kuva"],
    () => Promise.resolve(new Response(png(600, 400))),
  );
  assert.equal(untyped?.contentType, "image/png");
});

test("nothing about the picture is allowed to throw at the import", async () => {
  // A site that will not answer, an address that was never fetchable, and a
  // body that never ends: all of them are "no picture", none of them is a
  // failed import.
  assert.equal(
    await fetchRecipeImage(["https://kuvat.example/pois.png"], () =>
      Promise.reject(new Error("connection reset"))),
    null,
  );
  assert.equal(await fetchRecipeImage(["ei mikään osoite"], () => {
    throw new Error("should never be dialled");
  }), null);
  assert.equal(await fetchRecipeImage([]), null);

  const chunk = new Uint8Array(200_000);
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
  });
  assert.equal(
    await fetchRecipeImage(["https://kuvat.example/loputon.png"], () =>
      Promise.resolve(new Response(endless, {
        headers: { "Content-Type": "image/png", "Content-Length": "42" },
      }))),
    null,
  );
  assert.ok(MAX_IMAGE_BYTES > 0);
});

test("a picture that redirects somewhere private is refused at the bounce", async () => {
  const image = await fetchRecipeImage(
    ["https://kuvat.example/uunikaali.png"],
    (url) =>
      Promise.resolve(
        url.endsWith("uunikaali.png")
          ? new Response(null, {
              status: 302,
              headers: { Location: "http://169.254.169.254/kuva.png" },
            })
          : imageResponse(png(400, 300)),
      ),
  );
  assert.equal(image, null);
});

/** A page carrying one JSON-LD node, plus whatever metadata a test needs. */
function pageWith(node: unknown, head = ""): string {
  return `<!doctype html><html><head>${head}
    <script type="application/ld+json">${JSON.stringify(node)}</script>
    </head><body><main><h1>Uunikaali</h1></main></body></html>`;
}

function imageResponse(bytes: Buffer): Response {
  return new Response(bytes, { headers: { "Content-Type": "image/png" } });
}
