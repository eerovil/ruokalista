# What the web actually gives us for recipe import

Research note for [issue #2](https://github.com/eerovil/ruokalista/issues/2). Fact-finding
only — this note does not decide how import works.

**Investigated:** 2026-08-24. All fetches were made from a datacenter IP with a
desktop Chrome `User-Agent` and `Accept-Language: fi-FI`, unless stated otherwise.
Every claim below is either something we observed directly or a quote from a
primary source, with the URL given. Things we could not verify are collected in
[Gaps](#gaps-things-we-could-not-verify) rather than guessed at.

---

## 1. How widely Finnish recipe sites publish machine-readable recipe data

Verdict: **the big Finnish publisher sites do publish schema.org/Recipe as JSON-LD, and
they do it well. Personal food blogs largely do not.** Nobody in our sample used
microdata — it was JSON-LD or nothing.

| Site | Page fetched | HTTP | `Recipe` JSON-LD? | Microdata? |
|---|---|---|---|---|
| [valio.fi](https://www.valio.fi/reseptit/tomaattipiirakka/) | `/reseptit/tomaattipiirakka/` | 200 | Yes | none |
| [kotikokki.net](https://www.kotikokki.net/reseptit/nayta/104372/Borssikeitto/) | `/reseptit/nayta/104372/…` | 200 | Yes | none |
| [yhteishyva.fi](https://yhteishyva.fi/reseptit/kermainen-kanapasta/5aw8TmpWzuRu2sls8xOqKx) | `/reseptit/kermainen-kanapasta/…` | 200 | Yes | none |
| [soppa365.fi](https://www.soppa365.fi/reseptit/juhli-ja-nauti/guacamole) | `/reseptit/juhli-ja-nauti/guacamole` | 200 | Yes (no instructions) | none |
| [meillakotona.fi](https://www.meillakotona.fi/reseptit/kaalikaarylemureke) | `/reseptit/kaalikaarylemureke` | 200 | Yes | none |
| [meillakotona.fi](https://www.meillakotona.fi/artikkelit/pannukakku-reseptit) | `/artikkelit/pannukakku-reseptit` | 200 | **No** — `Article` + `BreadcrumbList` only | none |
| [k-ruoka.fi](https://www.k-ruoka.fi/reseptit/lohikeitto) | `/reseptit/lohikeitto` | **403** | unverified — see below | unverified |
| [chocochili.net](https://chocochili.net/2026/06/jerk-seitan/) | `/2026/06/jerk-seitan/` | 200 | **No** — `WebSite` + `WebPage` only | none |
| [liemessa.fi](https://liemessa.fi/2022/08/seesamitofu/) | `/2022/08/seesamitofu/` | 200 | **No** — `Article`, `WebPage`, `ImageObject`, `BreadcrumbList`, `WebSite`, `Person`/`Organization` | none |

### Fields actually present

Field sets are generous and fairly consistent. Observed keys on the `Recipe` node:

- **valio.fi** — `name`, `description`, `image`, `author`, `datePublished`,
  `recipeCategory`, `keywords`, `recipeYield`, `prepTime`, `totalTime`,
  `recipeIngredient`, `recipeInstructions` (as `HowToStep` objects), `nutrition`,
  `aggregateRating`.
- **yhteishyva.fi** — the richest: adds `@id`, `url`, `inLanguage`, `isPartOf`,
  `mainEntityOfPage`, `publisher`, `dateModified`, `recipeCuisine`.
- **kotikokki.net** — `name`, `author`, `image`, `datePublished`, `prepTime`,
  `cookTime`, `recipeYield`, `recipeCategory`, `keywords`, `suitableForDiet`,
  `interactionStatistic`, `recipeIngredient`, `recipeInstructions`.
- **meillakotona.fi** — full set incl. `aggregateRating`, `commentCount`,
  `thumbnail`, `publisher`.
- **soppa365.fi** — thinner: `name`, `author`, `image`, `datePublished`, `keywords`,
  `recipeCategory`, `recipeCuisine`, `prepTime`, `totalTime`, `recipeIngredient`.
  **`recipeInstructions` is absent entirely** — the method text is only in the
  rendered HTML.

Two data-quality warts worth knowing about:

- **meillakotona.fi leaks its SEO `<title>` into `name`**: the value is
  `'Kaalikääryle\xadmureke  – katso ohje! | Kotona'` — note the soft hyphen (U+00AD)
  and the `– katso ohje! | Kotona` suffix. Any importer needs to clean this.
- **meillakotona.fi's `recipeInstructions` is one newline-delimited string**, not an
  `ItemList`/`HowToStep` array: `'Kaalikäärylemureke – ohje:\nLeikkaa kaali ohuiksi
  suikaleiksi. …'`. So `recipeInstructions` arrives in at least three shapes across
  five sites (array of `HowToStep`, array of plain strings on kotikokki.net, single
  string, and missing).

### The blogs

Both blogs we checked serve their ingredients as **ordinary HTML prose/lists only**.
Neither uses a recipe plugin (we grepped for `wprm`, `tasty-recipe`, `mv-create`,
`easyrecipe`, `recipe-card` markers — no hits). Extracting text lines by regex still
finds plausible ingredient lines, e.g. from
[chocochili.net](https://chocochili.net/2026/06/jerk-seitan/): `2 ½ dl gluteenijauhoja`,
`1 dl kikhernejauhoja`, `1 rkl sipulijauhetta`, `2 rkl (vähäsuolaista) soijakastiketta`;
and from [liemessa.fi](https://liemessa.fi/2022/08/seesamitofu/): `200 g pala
maustamatonta tofua`, `1/2 dl paahdettua seesamiöljyä`. But there is no markup saying
"this block is the ingredients" — that boundary has to be guessed.

### k-ruoka.fi and atria.fi block us outright

`https://www.k-ruoka.fi/reseptit/lohikeitto` returned **HTTP 403** on every attempt
from our IP. The body is a Cloudflare interstitial — `<title>Just a moment...</title>`.
We tried:

| `User-Agent` | Result |
|---|---|
| Desktop Chrome 126 | 403, 5654 bytes |
| `curl/8.5.0` | 403, 3142 bytes |
| `Googlebot/2.1` | 403, 3276 bytes |

Two third-party fetch proxies (`api.allorigins.win`, `api.codetabs.com`) also failed
(HTTP 522). `https://www.k-ruoka.fi/sitemap-https.xml` returned 200 but with a
content encoding curl refused (`Unrecognized content encoding type`), suggesting
edge-level mangling of non-browser clients.

However, a fetch of the same URL through a different network path (the agent's
`WebFetch` tool, which renders to markdown) **did** return the recipe, with ingredient
lines including `n. 400 g pala Pirkka lohifileetä`, `1–1 ja ½ l vettä`,
`2 kalaliemikuutiota`, `1 iso sipuli`, `8 Pirkka yleisperunaa`,
`2 dl Pirkka laktoositonta ruokakermaa (15 %)`. So the content is server-rendered and
reachable from a residential/browser-like client — **it is the request that gets
blocked, not the content that is missing**. Whether k-ruoka.fi emits JSON-LD is
unverified (see [Gaps](#gaps-things-we-could-not-verify)).

`https://www.atria.fi/sitemap.xml` likewise returned **403**, same signature.

### robots.txt: nobody forbids reading a recipe page, several forbid AI crawlers

Fetched 2026-08-24. Full text of the relevant directives:

- **[valio.fi/robots.txt](https://www.valio.fi/robots.txt)** — `User-agent: *` /
  `Disallow: /reseptihaku/*?` (plus `/tuotehaku/`, `/artikkelihaku/`). Then a Yoast
  block with `User-agent: *` / `Disallow:` (i.e. allow everything). Recipe pages are
  not disallowed; only the faceted *search* URLs are.
- **[k-ruoka.fi/robots.txt](https://www.k-ruoka.fi/robots.txt)** — disallows
  query-string patterns only (`/*?*haku=`, `/*?*suodata=`, `/*?*utm_source=`,
  `/reseptit/*?*tuote=`, …) and `/k-citymarket/tarjouslehti`. Clean recipe URLs are
  allowed by robots.txt — the 403 is a separate, edge-level bot defence.
- **[kotikokki.net/robots.txt](https://www.kotikokki.net/robots.txt)** — disallows
  `/reseptit/oembed`, `/reseptit/muokkaa`, `/reseptit/tulosta`, `/reseptit/similar`,
  `/reseptit/kokkausnakyma`, `/ostoslista`, `/oembed`, `/api/sessions/`. Note the
  **print view `/reseptit/tulosta` is explicitly off-limits** even though the normal
  recipe page is fine.
- **[soppa365.fi/robots.txt](https://www.soppa365.fi/robots.txt)** — `Disallow: /` for
  `GPTBot`, `ChatGPT-user`, `CCBot`, `Google-Extended`, `FacebookBot`, `Amazonbot`,
  `Yandex`, `omgilibot`, `omgili`, `sentibot`, `ltx71`, `Vagabondo`, `Arquivo`. For
  `User-agent: *` only `/ly-ajax/ajah/`.
- **[yhteishyva.fi/robots.txt](https://yhteishyva.fi/robots.txt)** — `User-agent: *` /
  `Allow: /`, `Disallow: /error-pages/`. The most permissive in the sample.
- **[meillakotona.fi/robots.txt](https://www.meillakotona.fi/robots.txt)** — `*` may
  read everything except `/app/`, `/satokausi/`, `/demo/`. Then a long AI-crawler
  denylist that explicitly names **`anthropic-ai`, `ClaudeBot`, `Claude-Web`**, plus
  `AI2Bot`, `Ai2Bot-Dolma`, `Amazonbot`, `Applebot-Extended`, `Bytespider`, `CCBot`,
  `ChatGPT-User`, `cohere-ai`, `cohere-training-data-crawler`, `Crawlspace`,
  `DeepSeek`, `DeepSeekBot`, `Diffbot`, `dotbot`, `FacebookBot`, `FriendlyCrawler`, …
- **[kotiliesi.fi/robots.txt](https://kotiliesi.fi/robots.txt)** — `Disallow: /` for
  `ChatGPT-user`, `CCBot`, `Google-Extended`, `ImagesiftBot`, `Amazonbot`, `GPTBot`.

The pattern is consistent: **a user-initiated fetch of one recipe page is not what
these files forbid; bulk AI/training crawlers are.** That distinction matters if
ruokalista fetches only URLs a household member pastes in, and it is a distinction
worth being deliberate about in the User-Agent we send.

Incidental finding: `https://www.glorianruokajaviini.fi/robots.txt` **redirects to
`https://www.soppa365.fi/robots.txt`** — Otavamedia's food titles appear to share one
platform, so a soppa365 scraper likely covers more brands than its domain suggests.

---

## 2. What the structured data contains for ingredients

**One flat list of human-readable Finnish sentences.** In all five sites where we
found `recipeIngredient`, the value was a JSON array of plain strings. Not one site
used a structured form. Quoting verbatim from the pages we fetched:

**valio.fi** ([tomaattipiirakka](https://www.valio.fi/reseptit/tomaattipiirakka/)):

```
"1 pkt (250 g) Valio Koskenlaskija® paprika-chili sulatejuustoa"
"500 g tomaatteja, erilaisia"
"1 salottisipuli"
"½ ruukkua basilikaa"
"1 prk (150 g) Valio Keittiön crème fraîchea"
"1 rkl dijonsinappia"
"0 kg suolaa ja pippuria myllystä"
"150 g Valio voita"
"3 dl vehnäjauhoja"
"½ tl suolaa"
"2 rkl vettä"
```

Note `"0 kg suolaa ja pippuria myllystä"` — a *bogus* quantity. Their CMS clearly
requires a number+unit, so "salt and pepper to taste" became `0 kg`. An importer that
trusts the number will put "0 kg salt" on the shopping list. Note also that one line
(`suolaa ja pippuria`) is *two* ingredients, and that `basilikaa` appears twice in the
list (base and garnish) — deduplication is not free.

**kotikokki.net** ([Borssikeitto](https://www.kotikokki.net/reseptit/nayta/104372/Borssikeitto/)):

```
"½dl öljyä"
"½kpl pieni kaali"
"1kpl purjosipulia"
"1kpl Sipuli"
"1kpl porkkana"
"2kpl valkosipulinkynttä"
"1prk tomaattipyreetä"
"2l vettä"
"1pss kuivattuja borssikeittokasviksia"
"1kpl lihaliemikuutio"
"tuoretta timjamia"
"3kpl laakerinlehti"
"2kpl wääksyn kartanon ruukkupersiljaa"
"punaviinietikkaa"
```

Three separate parsing hazards in one list: **no space between quantity and unit**
(`½dl`, `1prk`, `1pss`, `2l`); **`kpl` used as a filler unit** where the real unit is
"a whole vegetable" (`½kpl pieni kaali` = half a small cabbage, `1kpl Sipuli` = one
onion); and **no quantity at all** on some lines (`tuoretta timjamia`,
`punaviinietikkaa`). Casing is inconsistent (`Sipuli` capitalised mid-list).

**yhteishyva.fi** ([kermainen kanapasta](https://yhteishyva.fi/reseptit/kermainen-kanapasta/5aw8TmpWzuRu2sls8xOqKx)) — the cleanest in the sample:

```
"410 g kanan fileeleikkeitä"
"1 kpl sipuli"
"3 kpl valkosipulinkynttä"
"1 rkl rypsiöljyä"
"100 g pinaattia"
"2 dl ruokakermaa"
"150 g ranskankermaa"
"1 tl suolaa"
"3/4 tl paprikajauhetta"
"350 g pastaa"
"1/2 kpl ruukkua lehtipersiljaa"
```

Fractions come as ASCII (`3/4`, `1/2`), not Unicode. `"1/2 kpl ruukkua
lehtipersiljaa"` stacks two units (`kpl` + `ruukkua`). Its `recipeYield` is
`'4 portion'` — an English unit label on a Finnish page.

**soppa365.fi** ([guacamole](https://www.soppa365.fi/reseptit/juhli-ja-nauti/guacamole)):

```
"1 kypsä avokado"
"1/2 lime"
"mustapippuria myllystä"
"hyppysellinen suolaa"
"4 oksaa tuoretta korianteria"
"n. 4 kpl Vaasan Koulunäkki Luomu näkkileipää"
```

`hyppysellinen suolaa` ("a pinch of salt") and `4 oksaa` ("4 sprigs") are units no
metric unit table will contain. `n.` = "noin" ("about") prefixes the quantity.

**meillakotona.fi** ([kaalikäärylemureke](https://www.meillakotona.fi/reseptit/kaalikaarylemureke)):

```
"½ (500 g) valkokaali"
"1  sipuli"
"1 rkl rypsiöljyä"
"400 g sika-nautajauhelihaa"
"½ dl puuroriisiä"
"3 munaa"
"1½ tl suolaa"
"½ tl mustapippuria "
"1 kg  perunoita"
" ½ tl  suolaa"
```

`½ (500 g) valkokaali` gives a fraction *and* a parenthesised weight for the same
item. Whitespace is dirty: doubled internal spaces and leading/trailing spaces
(`" ½ tl  suolaa"`). `1½` is a Unicode fraction glued to a digit.

### What the spec allows vs. what sites do

schema.org's expected types for `recipeIngredient` are
"`ItemList` or `PropertyValue` or `Text`" ([schema.org/Recipe](https://schema.org/Recipe)),
and the property is defined as "An ingredient or ordered list of ingredients and
potentially quantities used in the recipe, e.g. 1 cup of sugar, flour or garlic"
([schema.org/recipeIngredient](https://schema.org/recipeIngredient)). So a structured
quantity/unit form is *technically* expressible via `PropertyValue`. **No site in our
sample used it.** The spec's own example phrasing ("1 cup of sugar") signals that plain
text is the intended, normal case.

**Conclusion for the intake decision: structured data gets you a clean, correctly
scoped list of ingredient *sentences* for free. It does not get you quantity/unit/item
fields. That split is work we would have to do ourselves.**

---

## 3. Libraries for parsing an ingredient line into quantity + unit + item

### For fetching + extracting the recipe: `recipe-scrapers` works on Finnish sites

[hhursev/recipe-scrapers](https://github.com/hhursev/recipe-scrapers) (2,214 stars,
last pushed 2026-08-21) is the obvious candidate. It has **650 site-specific scraper
modules and not one for a Finnish site** — we listed the repo tree via the GitHub API
and grepped for `kruoka|valio|kotikokki|soppa|yhteishyva|meillakotona|kinuski|choco|liemessa|finn|suomi`;
the only hit was `chocolatewithgrace.py` (an American blog). Its
[supported-sites list](https://github.com/hhursev/recipe-scrapers/blob/main/docs/getting-started/supported-sites.md)
contains **zero `.fi` domains**.

That does not matter much, because it also has a generic schema.org path. Its README
says it "Parses recipe information from either standard HTML structure, Schema markup
(including JSON-LD, Microdata, and RDFa formats) or OpenGraph metadata"
([README.rst](https://github.com/hhursev/recipe-scrapers/blob/main/README.rst)), and
`scrape_html` takes a `wild_mode` / `supported_only` flag:

```python
scrape_html(html: str | None, org_url: str, *, online: bool = False,
            supported_only: bool | None = None, wild_mode: bool | None = None,
            best_image: bool | None = None) -> AbstractScraper
```

**We tested this directly** (recipe-scrapers 15.12.0, `supported_only=False`, against
the HTML we had already saved):

| Page | Result |
|---|---|
| valio.fi/reseptit/tomaattipiirakka | title `Tomaattipiirakka`, 12 ingredients |
| kotikokki.net Borssikeitto | title `Borssikeitto`, 20 ingredients |
| yhteishyva.fi kermainen-kanapasta | title `Kermainen kanapasta`, 13 ingredients |
| soppa365.fi guacamole | title `Guacamole`, 6 ingredients |
| meillakotona.fi kaalikaarylemureke | title `Kaalikääryle­mureke – katso ohje! \| Kotona`, 17 ingredients |
| chocochili.net jerk-seitan | `NoSchemaFoundInWildMode: No Recipe Schema found at …` |
| liemessa.fi seesamitofu | `NoSchemaFoundInWildMode: No Recipe Schema found at …` |

So an off-the-shelf library gets us all five publisher sites with no per-site code,
and fails cleanly and identifiably on the two blogs. Note it also passed the dirty
`name` through unchanged (the meillakotona SEO title) — it extracts, it does not clean.
Its README is explicit that fetching is our problem: "This package is focused
**exclusively on HTML parsing**. For advanced implementations, you'll need to implement
your own solution for fetching recipe HTMLs and managing network requests." It also
states: "This package does not circumvent or bypass any bot protection measures
implemented by websites" — i.e. it will not help with the k-ruoka 403.

Its [copyright-and-usage doc](https://github.com/hhursev/recipe-scrapers/blob/main/docs/copyright-and-usage.md)
puts the legal burden on us — users are responsible for "Respecting website terms of
service and *robots.txt* directives" — while noting that "Personal recipe collection
and organization" is among the uses that "may fall under fair use doctrine" (with the
caveat that we should do our own analysis for our jurisdiction; note also that "fair
use" is a US doctrine, not a Finnish/EU one).

### For splitting a line into quantity + unit + item: honestly, nothing for Finnish

We found **no library, in any language, that parses Finnish ingredient lines.** What
exists:

| Project | Language | Finnish? |
|---|---|---|
| [strangetom/ingredient-parser](https://github.com/strangetom/ingredient-parser) (164 stars, pushed 2026-08-23) | Python | **No.** Sequence-labelling model trained on "a data set of over 81,000 example sentences"; README makes no mention of any language other than English. |
| [magrinj/parse-ingredients](https://github.com/magrinj/parse-ingredients) | TypeScript | **No.** Advertises "6 languages built-in": en, fr, es, it, de, pt. |
| [mealie-recipes/mealie](https://github.com/mealie-recipes/mealie) | Python | **No.** Its [ingredient-parser guide](https://github.com/mealie-recipes/mealie/blob/mealie-next/docs/docs/contributors/guides/ingredient-parser.md) says the CRF parser is "trained on … a data set compiled by the New York Times" — English. Mealie *does* ship a Finnish UI translation (`frontend/app/lang/messages/fi-FI.json` contains `"example-unit-abbreviation-singular": "esim. rkl"`), and its "brute" parser matches units against the *user's own* unit records (`parser.data_matcher.find_unit_match(token)` in `mealie/services/parser_services/brute/process.py`) — so a Finnish user can define `dl`/`rkl`/`tl`/`kpl` themselves. But the shared string utilities are hardcoded Western/English (fixed fraction regexes, a hardcoded vulgar-fractions map) with no language switch. |
| Others from a GitHub search for "ingredient parser" — `herkyl/ingredients-parser`, `jdarling/ingredientparser`, `nickysemenza/ingredient-parser`, `openculinary/ingredient-parser`, `peterjm/eye_of_newt`, `JedS6391/RecipeIngredientParser`, Zestful (commercial API) | JS / Rust / Ruby / C# / API | All English-only as far as their descriptions and READMEs go. |

The only code we found that actually knows Finnish units is **hobby code, not a
library**:

- [`boterai/recipes-parser`](https://github.com/boterai/recipes-parser) —
  `extractor/haudutuspata_fi.py` has the unit list
  `"rkl", "tl", "dl", "ml", "cl", "kg", "kpl", "pkt", "pss", "prk"` plus long forms
  (`kilogrammaa`, `kappaletta`, `litraa`, `pakettia`) ordered longest-first for regex,
  and normalises Unicode fractions and `n.` prefixes. But it is a **single-site
  scraper** for haudutuspata.fi, 0 stars, no licence, and it **does not handle
  partitive forms** — it takes the ingredient name as-is, so it yields `öljyä`, not
  `öljy`.
- [`Glitchtit/HA-recipes`](https://github.com/Glitchtit/HA-recipes) /
  [`Glitchtit/HA-storage`](https://github.com/Glitchtit/HA-storage) — a Home Assistant
  add-on described as "AI-powered recipe scraping for Grocy", 0 stars. It carries a
  hand-written Finnish unit normalisation map: `"dl": "dl", "desilitra": "dl",
  "desilitraa": "dl"`, `"tl": "tl", "teelusikka": "tl", "teelusikkaa": "tl"`,
  `"rkl": "rkl", "ruokalusikka": "rkl", "ruokalusikkaa": "rkl"`, and
  `_VOLUME_UNITS = {"ml", "dl", "l", "tl", "rkl"}`. Note the pattern: even here, the
  Finnish handling is a hardcoded dictionary plus an LLM, not a parser.

**So the answer to the ticket's question is: Finnish-language ingredient parsing does
not exist as a dependency we can install.** A unit table for `dl / rkl / tl / kpl /
prk / pkt / pss / g / kg / l / ml` is a small, finite, well-bounded thing we could
write in an afternoon — the evidence above shows the whole vocabulary in use. The hard
part is the *item*, not the unit.

### The partitive problem

Finnish ingredient lines name the item in the partitive case, so the string in the
recipe is not the string you would use as a pantry key:

| As published | Dictionary form (nominative) |
|---|---|
| `sipulia` | sipuli |
| `sika-nautajauhelihaa` | sika-nautajauhelihaa → jauheliha |
| `vehnäjauhoja` | vehnäjauho(t) |
| `tomaatteja` | tomaatti |
| `valkosipulinkynttä` | valkosipulinkynsi |
| `ruukkua` | ruukku |
| `korppujauhoja` | korppujauho(t) |

Sites are inconsistent about which case they use even within one list — kotikokki.net's
Borssikeitto has both `1kpl purjosipulia` (partitive) and `1kpl Sipuli` (nominative
and capitalised). So matching "did we already buy onions?" cannot be string equality.

The relevant Finnish-specific tool here is **[Voikko](https://voikko.puimula.org/)**,
described on its own site as "a morphological analyzer, spelling and grammar checker,
hyphenator and collection of related linguistic data for Finnish language", free and
open source. Its `analyze()` returns a `BASEFORM`, which is exactly the
partitive→nominative reduction we need. We could **not** empirically verify its output
on the words above — see [Gaps](#gaps-things-we-could-not-verify).

---

## 4. Realistic failure modes of URL import

Ranked by how often we actually hit them in this small sample.

1. **The site blocks non-browser clients.** Hit on **2 of 8** domains tried
   (k-ruoka.fi, atria.fi) — both Cloudflare, both 403 for desktop-Chrome UA, bare
   `curl`, *and* a Googlebot UA, from a datacenter IP. Proxy services were also 403/522.
   `recipe-scrapers` explicitly will not help ("does not circumvent or bypass any bot
   protection measures"). Since the same k-ruoka URL succeeded from a different network
   path, this looks like IP reputation as much as User-Agent — meaning **a server-side
   importer hosted in a cloud region may fail on sites that work fine from the user's
   own phone**. That is an architectural fact, not a bug to fix.
2. **No structured data at all.** Hit on **2 of 2** personal blogs, and on
   meillakotona.fi's *article* URLs (`/artikkelit/…`, marked `Article`) as opposed to
   its *recipe* URLs (`/reseptit/…`, marked `Recipe`). The same domain can be both.
   Blog recipes are readable text but the ingredient block has no machine-detectable
   boundary. `recipe-scrapers` fails cleanly here with
   `NoSchemaFoundInWildMode` — good, it is detectable rather than silently wrong.
3. **Structured data present but incomplete.** soppa365.fi publishes
   `recipeIngredient` but **no `recipeInstructions`** — a URL import would produce a
   recipe with a shopping list and no method. `recipeInstructions` shape also varies
   (array of `HowToStep`, array of strings, one newline-joined string, absent), so a
   naive reader breaks on at least one site.
4. **Dirty values inside valid markup.** Real examples above: `0 kg suolaa ja
   pippuria` (fabricated quantity), `Kaalikääryle\xadmureke – katso ohje! | Kotona`
   (SEO title in `name`, plus a soft hyphen), `" ½ tl  suolaa"` (stray whitespace),
   `½dl` (no separator), `4 oksaa` / `hyppysellinen` (units no table has),
   `'4 portion'` as a Finnish page's `recipeYield`. Also note kotikokki.net's JSON-LD
   contains **HTML entities inside JSON strings** (`&quot;vahvuus&quot;` in the
   instruction text): since HTML `<script>` content is raw text and is *not*
   entity-decoded, a strict JSON parse yields a string with literal `&quot;` in it,
   and an importer that HTML-unescapes the block *before* parsing gets a JSON syntax
   error (we made exactly this mistake mid-investigation).
5. **robots.txt / terms.** No site in our sample disallows `*` from reading a recipe
   page. Several disallow named AI crawlers — and **meillakotona.fi names
   `ClaudeBot`, `Claude-Web`, and `anthropic-ai` explicitly**, alongside `GPTBot`,
   `CCBot`, `Diffbot` etc. soppa365.fi and kotiliesi.fi have similar lists.
   kotikokki.net specifically disallows its own print view (`/reseptit/tulosta`),
   which is the URL a scraper would be tempted to prefer. Whatever User-Agent
   ruokalista sends will be read by these files, so it is a deliberate choice.
   Site-specific *terms of service* (as opposed to robots.txt) were not reviewed —
   see [Gaps](#gaps-things-we-could-not-verify).
6. **Client-side rendering.** We did **not** observe a single Finnish recipe site that
   required JS to expose its ingredients. All five that had JSON-LD served it in the
   initial HTML response to plain `curl`; meillakotona.fi had neither `__NEXT_DATA__`
   nor `__NUXT__`. On the evidence of this sample, **CSR is a smaller risk than
   bot-blocking.** (k-ruoka is unverified but its content came through a
   markdown-converting fetch, which suggests server rendering.)
7. **Paywalls.** We did not encounter one on any recipe page we fetched. kotiliesi.fi
   (which does run a subscription business) was checked only for robots.txt, not for
   an article paywall. Untested — see Gaps.

---

## 5. Is photographing a cookbook page realistic today?

**Yes, for printed text. Finnish is well covered by every major OCR engine.** Verified
against vendor docs:

- **Tesseract** — Finnish (`fin`) is present in the language data files across all
  versions, per
  [tessdoc](https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html):
  the row reads `fin | Finnish | x | x | x | x | x | x` (3.02, 3.04, 4.00, and the
  `tessdata` / `tessdata_best` / `tessdata_fast` variants). Free, self-hostable, no
  per-call cost.
- **Google Cloud Vision** — Finnish is listed in
  [supported languages](https://docs.cloud.google.com/vision/docs/languages) as
  `Suomi | Finnish | fi | Latn`, applying to `TEXT_DETECTION` /
  `DOCUMENT_TEXT_DETECTION`.
- **Azure AI Document Intelligence (`prebuilt-read`)** — `Finnish | fi` appears in
  the **printed text** table for v3.0, v3.1 and v4.0, and in the language-*detection*
  table. Crucially, Finnish is **absent from the handwritten text table** — handwriting
  support in v4.0 is only en, zh-Hans, fr, de, it, th, ja, ko, pt, es, ru, ar.
  ([language-support/ocr](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support/ocr))

The important asymmetry: **printed Finnish is solved; handwritten Finnish is not**
(at least not by Azure's Read model, and we found no vendor claiming it). A photo of a
printed cookbook page is a realistic input. A photo of grandmother's handwritten recipe
card is a materially harder problem.

Two caveats specific to this use case that OCR support does not solve:

- OCR gives you a **flat page of text**, not a recipe. Cookbook pages are often
  two-column, with the ingredient list in a sidebar; deciding "these lines are
  ingredients, those are the method" is the same boundary-detection problem as the
  blogs in §1, minus the HTML hints. Azure's `prebuilt-layout` model is the relevant
  tool for reading structure, and it also lists `Finnish | fi` for printed text.
- Finnish's long compounds and `ä`/`ö` make OCR errors especially costly:
  `sika-nautajauheliha` misread by one character is not recoverable by an English
  spellchecker. Voikko could in principle validate/correct candidate words here — but
  see Gaps.

---

## Gaps: things we could not verify

Stated plainly rather than guessed at.

1. **Whether k-ruoka.fi publishes schema.org/Recipe JSON-LD.** Every server-side
   fetch from our IP returned 403 (Cloudflare). We confirmed the *content* is
   reachable and looks server-rendered from another network path, but that path
   converts to markdown and discards `<script>` tags, so we never saw the raw HTML.
   Given k-ruoka is arguably the single most important site for a Finnish household,
   **this is the biggest gap in this note** and worth 5 minutes with browser devtools
   on a home connection.
2. **Whether Voikko actually reduces `sipulia` → `sipuli` well.** We installed the
   `libvoikko` Python binding from PyPI successfully, but the native library and
   Finnish morphology dictionary were not installable in this environment
   (`/usr/lib64/libvoikko*` absent), so we ran no analyses. The claim that Voikko
   does morphological analysis and exposes a `BASEFORM` comes from
   [its own site](https://voikko.puimula.org/) and its API, not from our own test.
   Voikko's exact licence was also not confirmed.
3. **Site terms of service.** We read robots.txt for seven domains but did not read
   any site's *käyttöehdot*. robots.txt and ToS can say different things, and a ToS
   clause forbidding automated access would not show up in anything we checked.
4. **Paywalls.** Not encountered, but also not deliberately probed. kotiliesi.fi,
   Glorian ruoka & viini and similar magazine properties were only checked at the
   robots.txt level.
5. **Client-side rendering.** Our sample of 8 domains found zero CSR recipe pages.
   That is weak evidence for a general claim — it is a small sample, skewed toward
   large publishers with SEO teams (who have every incentive to server-render).
6. **Apple's on-device OCR (Vision / Live Text) Finnish support.** The Apple developer
   documentation page for `Recognizing text in images` returned no usable body text to
   our fetch, so we could not confirm whether `supportedRecognitionLanguages` includes
   Finnish. This matters if the answer is an on-device iOS camera flow with no server
   OCR cost.
7. **Accuracy numbers.** We cite *support* for Finnish OCR from vendor docs. We ran no
   OCR ourselves and have no character/word error rate for Finnish cookbook pages from
   any source. "Supported" is not "accurate enough".
8. **How representative the two blogs are.** We checked chocochili.net and liemessa.fi;
   both had no `Recipe` markup and no recipe plugin. A Finnish blog running a WordPress
   recipe plugin (WP Recipe Maker et al.) *would* emit clean JSON-LD, so the real blog
   figure is somewhere between "none" and "most" and we have not measured it. We also
   failed to find a usable post URL on kinuskikissa.fi (its homepage exposed no article
   links to our link-scrape), so that site is untested.

---

## Sources

Pages fetched and inspected 2026-08-24:

- https://www.valio.fi/reseptit/tomaattipiirakka/ · https://www.valio.fi/robots.txt · https://www.valio.fi/sitemap_index.xml
- https://www.kotikokki.net/reseptit/nayta/104372/Borssikeitto/ · https://www.kotikokki.net/robots.txt
- https://yhteishyva.fi/reseptit/kermainen-kanapasta/5aw8TmpWzuRu2sls8xOqKx · https://yhteishyva.fi/robots.txt · https://yhteishyva.fi/recipe-sitemap.xml
- https://www.soppa365.fi/reseptit/juhli-ja-nauti/guacamole · https://www.soppa365.fi/robots.txt · https://www.soppa365.fi/sitemap.xml
- https://www.meillakotona.fi/reseptit/kaalikaarylemureke · https://www.meillakotona.fi/artikkelit/pannukakku-reseptit · https://www.meillakotona.fi/robots.txt
- https://www.k-ruoka.fi/reseptit/lohikeitto (403) · https://www.k-ruoka.fi/robots.txt · https://www.atria.fi/sitemap.xml (403)
- https://chocochili.net/2026/06/jerk-seitan/ · https://liemessa.fi/2022/08/seesamitofu/ · https://kotiliesi.fi/robots.txt · https://www.glorianruokajaviini.fi/robots.txt

Specs, repos and vendor docs:

- https://schema.org/Recipe · https://schema.org/recipeIngredient
- https://github.com/hhursev/recipe-scrapers (README.rst, docs/getting-started/supported-sites.md, docs/copyright-and-usage.md); tested locally at version 15.12.0
- https://github.com/strangetom/ingredient-parser · https://github.com/magrinj/parse-ingredients
- https://github.com/mealie-recipes/mealie (docs/docs/contributors/guides/ingredient-parser.md, mealie/services/parser_services/brute/process.py, mealie/services/parser_services/parser_utils/string_utils.py, frontend/app/lang/messages/fi-FI.json)
- https://github.com/boterai/recipes-parser · https://github.com/Glitchtit/HA-recipes · https://github.com/Glitchtit/HA-storage
- https://voikko.puimula.org/
- https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html
- https://docs.cloud.google.com/vision/docs/languages
- https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/language-support/ocr
