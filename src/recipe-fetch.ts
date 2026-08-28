/**
 * Reading a recipe off a web page (#192).
 *
 * Wayfinder decision #4 ruled this out in favour of pasted text alone, and
 * `docs/codebase/intake.md` recorded why. Issue #192 reverses that half of it;
 * see docs/adr/0011-a-web-address-is-a-third-way-in.md. What #4 got right is
 * still honoured here: nothing on the page is trusted, nothing is stored but
 * text and the address, and the model still does the structuring.
 *
 * This module never calls a model. It turns an address into the plainest text
 * the page can be reduced to, and everything after that is the ordinary intake
 * path — which is what keeps there being one importer rather than two.
 */

/** How long the whole fetch, redirects included, may take. */
export const FETCH_TIMEOUT_MS = 12_000;

/** How much of a page is read before giving up on it. */
export const MAX_PAGE_BYTES = 3_000_000;

/** How much text is handed to the model. A recipe is far shorter than this. */
export const MAX_SOURCE_TEXT = 24_000;

/** How many redirects are followed, each one re-checked like the first. */
export const MAX_REDIRECTS = 5;

/** Below this a page yielded nothing worth calling a recipe. */
const MIN_FALLBACK_TEXT = 200;

/**
 * Why an address produced no recipe.
 *
 * A closed set of words rather than a sentence, on purpose: the browser island
 * owns every Finnish word a member reads (`docs/codebase/screens.md`), so the
 * server names the case and the island says it. A page's own error text — or
 * worse, somebody else's Finnish — never reaches a screen.
 */
export type FetchFailure =
  | "invalid_url"
  | "unreachable"
  | "not_a_page"
  | "too_large"
  | "no_recipe";

/** Thrown for every refusal in this module. The reason is the wire value. */
export class PageRefused extends Error {
  readonly reason: FetchFailure;

  constructor(reason: FetchFailure, detail: string) {
    super(detail);
    this.reason = reason;
  }
}

/** What a page gave up: the text to structure, plus what it was read from. */
export interface FetchedPage {
  /** The address finally read, after any redirects. */
  url: string;
  /** The recipe as plain text, ready for the ordinary model call. */
  sourceText: string;
  /** The page's own title for the dish, when it stated one structurally. */
  title: string | null;
  /** Whether structured `schema.org/Recipe` data was found, or text scraped. */
  structured: boolean;
}

/**
 * The address, checked before anything is dialled.
 *
 * A recipe page is addressed by a name on the public internet. Everything else
 * — a bare IP, a loopback or private name, a scheme that is not HTTP, an
 * address carrying credentials — is refused rather than fetched. A Worker's
 * `fetch` leaves Cloudflare and cannot reach this host's own network anyway,
 * but the household's address bar is not the place to find that out, and the
 * rule has to hold for every redirect hop too.
 */
export function normaliseRecipeUrl(input: string): URL {
  const trimmed = input.trim();
  if (trimmed === "") throw new PageRefused("invalid_url", "No address given.");

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new PageRefused("invalid_url", `Not a URL: ${trimmed}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageRefused("invalid_url", `Not an HTTP address: ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new PageRefused("invalid_url", "An address may not carry credentials.");
  }

  const host = url.hostname.toLowerCase();
  if (host === "") throw new PageRefused("invalid_url", "No host in the address.");

  // An IPv6 literal arrives bracketed; an IPv4 one is four numbers and nothing
  // else. Neither is how a recipe site is addressed, and both are how somebody
  // would try to point this at something that is not one.
  if (host.startsWith("[") || isIpv4Literal(host)) {
    throw new PageRefused("invalid_url", `Not a hostname: ${host}`);
  }
  if (!host.includes(".") || host.endsWith(".")) {
    throw new PageRefused("invalid_url", `Not a public hostname: ${host}`);
  }
  for (const suffix of [".localhost", ".local", ".internal", ".home.arpa"]) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) {
      throw new PageRefused("invalid_url", `Not a public hostname: ${host}`);
    }
  }

  // The fragment is the browser's business and never travels in a request.
  url.hash = "";
  return url;
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** The one shape this module needs of `fetch`, so a check can stand in for it. */
export type PageFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * Fetch a recipe page and reduce it to text.
 *
 * Redirects are followed by hand rather than by the platform: every hop goes
 * back through `normaliseRecipeUrl`, so a public address that bounces to a
 * private one is refused at the bounce instead of being fetched.
 */
export async function fetchRecipePage(
  address: string,
  fetcher: PageFetcher = fetch,
): Promise<FetchedPage> {
  let url = normaliseRecipeUrl(address);
  const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: deadline,
        headers: {
          // Named honestly. A site that would rather not be read this way can
          // see who is reading, which is the least a fetcher owes it.
          "User-Agent": "Ruokalista/1.0 (recipe import; +https://ruokalista.vilpponen.fi)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "fi,en;q=0.8",
        },
      });
    } catch (cause) {
      throw new PageRefused("unreachable", `Fetch failed: ${String(cause)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (location === null) {
        throw new PageRefused("unreachable", `Redirect with no Location: ${response.status}`);
      }
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw new PageRefused("unreachable", `Unreadable redirect: ${location}`);
      }
      url = normaliseRecipeUrl(next);
      continue;
    }

    if (!response.ok) {
      throw new PageRefused("unreachable", `Page answered ${response.status}.`);
    }

    const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
    if (
      contentType !== "" &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      throw new PageRefused("not_a_page", `Not a web page: ${contentType}`);
    }

    const markup = await readCapped(response);
    return readRecipeFromPage(markup, url.toString());
  }

  throw new PageRefused("unreachable", "Too many redirects.");
}

/**
 * The body, up to the cap.
 *
 * Read in chunks rather than through `response.text()`, because a `Content-Length`
 * is a claim and a body that keeps arriving is the case the cap exists for.
 */
async function readCapped(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) throw new PageRefused("not_a_page", "The page had no body.");

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let size = 0;
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PAGE_BYTES) {
        throw new PageRefused("too_large", `Page exceeded ${MAX_PAGE_BYTES} bytes.`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (cause) {
    if (cause instanceof PageRefused) throw cause;
    throw new PageRefused("unreachable", `Read failed: ${String(cause)}`);
  } finally {
    reader.releaseLock();
  }

  return text + decoder.decode();
}

/**
 * Markup in, recipe text out.
 *
 * Structured `schema.org/Recipe` data first — decision #2 found most Finnish
 * recipe sites publish it, and it is the difference between reading a recipe
 * and reading a page that has one on it somewhere. Where there is none, the
 * page's visible text is stripped out and handed over instead, which is the
 * same thing a member would have pasted by hand.
 */
export function readRecipeFromPage(markup: string, url: string): FetchedPage {
  const recipe = findRecipeData(markup);
  if (recipe !== null) {
    const sourceText = recipeText(recipe);
    if (sourceText.trim() !== "") {
      return {
        url,
        sourceText: capped(sourceText),
        title: stringField(recipe["name"]),
        structured: true,
      };
    }
  }

  const text = visibleText(markup);
  if (text.length < MIN_FALLBACK_TEXT) {
    throw new PageRefused("no_recipe", "The page yielded no readable text.");
  }

  return { url, sourceText: capped(text), title: null, structured: false };
}

function capped(text: string): string {
  return text.length <= MAX_SOURCE_TEXT ? text : text.slice(0, MAX_SOURCE_TEXT);
}

// ------------------------------------------------------------ structured data

type JsonObject = Record<string, unknown>;

/**
 * The first `schema.org/Recipe` node in any of the page's JSON-LD blocks.
 *
 * A page may carry several blocks and a block may be an array or a `@graph`,
 * so every node is walked. A block that will not parse is skipped rather than
 * refused: one broken block on a page is not a reason to lose the good one.
 */
export function findRecipeData(markup: string): JsonObject | null {
  for (const block of jsonLdBlocks(markup)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    const found = firstRecipeNode(parsed, 0);
    if (found !== null) return found;
  }
  return null;
}

function* jsonLdBlocks(markup: string): Generator<string> {
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of markup.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(attributes)) continue;
    // Some sites wrap the payload in a CDATA section or an HTML comment.
    yield (match[2] ?? "")
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .replace(/^\s*(?:\/\*)?\s*<!\[CDATA\[/, "")
      .replace(/\]\]>\s*(?:\*\/)?\s*$/, "");
  }
}

function firstRecipeNode(node: unknown, depth: number): JsonObject | null {
  if (depth > 8 || node === null || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = firstRecipeNode(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  const object = node as JsonObject;
  if (typeIncludes(object["@type"], "Recipe")) return object;

  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement"]) {
    const found = firstRecipeNode(object[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function typeIncludes(value: unknown, wanted: string): boolean {
  if (typeof value === "string") return value.split("/").pop() === wanted;
  if (Array.isArray(value)) return value.some((entry) => typeIncludes(entry, wanted));
  return false;
}

/**
 * A `Recipe` node as the plain Finnish text a member would have pasted.
 *
 * Deliberately not JSON: the model's whole prompt is written for a recipe as it
 * reads on a page, and `source_text` is kept forever as the record of what
 * arrived. A household opening "Näytä alkuperäinen" years later should find a
 * recipe there, not a data structure.
 */
export function recipeText(recipe: JsonObject): string {
  const blocks: string[] = [];

  const name = stringField(recipe["name"]);
  if (name !== null) blocks.push(name);

  const description = stringField(recipe["description"]);
  if (description !== null) blocks.push(description);

  const yields = yieldText(recipe["recipeYield"]);
  if (yields !== null) blocks.push(`Annoksia: ${yields}`);

  const ingredients = stringList(recipe["recipeIngredient"]);
  if (ingredients.length > 0) {
    blocks.push(["Ainekset:", ...ingredients].join("\n"));
  }

  const steps = instructionLines(recipe["recipeInstructions"], 0);
  if (steps.length > 0) {
    blocks.push(
      [
        "Valmistus:",
        ...steps.map((step, index) =>
          step.heading ? step.text : `${index + 1}. ${step.text}`,
        ),
      ].join("\n"),
    );
  }

  return blocks.join("\n\n").trim();
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = plainText(value);
  return text === "" ? null : text;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    const one = plainText(value);
    return one === "" ? [] : [one];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = typeof entry === "string" ? plainText(entry) : "";
    return text === "" ? [] : [text];
  });
}

function yieldText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return stringField(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = yieldText(entry);
      if (text !== null) return text;
    }
  }
  return null;
}

interface InstructionLine {
  text: string;
  /** A `HowToSection`'s name, which numbers nothing and titles what follows. */
  heading: boolean;
}

/**
 * `recipeInstructions` in every shape the wild uses it in: one string, a list
 * of strings, `HowToStep` objects, or `HowToSection`s holding those.
 *
 * A section's name is kept as a heading rather than dropped — that is exactly
 * the "kastike"/"täyte" wording the model reads as a named part of the dish.
 */
function instructionLines(value: unknown, depth: number): InstructionLine[] {
  if (depth > 4) return [];

  if (typeof value === "string") {
    return splitParagraphs(value).map((text) => ({ text, heading: false }));
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => instructionLines(entry, depth + 1));
  }

  if (value === null || typeof value !== "object") return [];
  const node = value as JsonObject;

  if (typeIncludes(node["@type"], "HowToSection")) {
    const name = stringField(node["name"]);
    const inner = instructionLines(node["itemListElement"], depth + 1);
    return name === null ? inner : [{ text: name, heading: true }, ...inner];
  }

  const text = stringField(node["text"]) ?? stringField(node["name"]);
  return text === null ? [] : [{ text, heading: false }];
}

function splitParagraphs(value: string): string[] {
  return plainText(value, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// --------------------------------------------------------------- plain text

/**
 * Markup out of a value, entities decoded, whitespace collapsed.
 *
 * JSON-LD fields routinely carry HTML — `<p>` around an instruction, a `<br>`
 * inside one — and that markup would otherwise be read to the model as if the
 * recipe said it.
 */
function plainText(value: string, joiner = " "): string {
  const broken = value
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");

  return decodeEntities(broken)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join(joiner)
    .trim();
}

/**
 * The page as text, for a page with no structured recipe on it.
 *
 * Everything that is not prose goes first — scripts, styles, templates and the
 * chrome around the article — because what is left is handed to a model, and a
 * navigation menu read as a recipe is worse than a short one.
 */
export function visibleText(markup: string): string {
  const stripped = markup
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  return plainText(stripped, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The handful of entities a Finnish recipe page actually uses, plus numeric
 * references. Everything else is left alone: an unknown entity read literally
 * is a cosmetic blemish, and guessing at one is not.
 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    auml: "ä",
    ouml: "ö",
    aring: "å",
    Auml: "Ä",
    Ouml: "Ö",
    Aring: "Å",
    frac12: "½",
    frac14: "¼",
    frac34: "¾",
    deg: "°",
    ndash: "–",
    mdash: "—",
  };

  return text
    .replace(/&#(\d+);/g, (_match, code: string) => codePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      codePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,9});/g, (match, name: string) =>
      Object.hasOwn(named, name) ? named[name] as string : match,
    );
}

function codePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}
