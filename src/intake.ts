import Anthropic from "@anthropic-ai/sdk";

import type { Env } from "./env.ts";
import type { DraftIngredientRef } from "./ingredient-refs.ts";
import { MAX_REFS_PER_STEP, mentionResolves } from "./ingredient-refs.ts";
import type { IngredientSummary } from "./ingredients.ts";
import { alternativeGroup, type AlternativeGroup } from "./alternatives.ts";
import { recipePhase, type RecipePhase } from "./recipe-phase.ts";

/**
 * Structuring: turning source text into a recipe's title, ingredients and
 * steps. Done by a language model, because no parser for Finnish ingredient
 * lines exists.
 *
 * The model that produced a draft is recorded on the recipe, so a future
 * re-import can tell what structured it. Decision #11 locked Sonnet 5, so the
 * model id is a constant here rather than an env override — an override was one
 * of the things that drifted in the closed attempt.
 */

const MODEL = "claude-sonnet-5";

/**
 * Thinking costs output tokens, and docs/spec.md's ~$0.03 an import assumed
 * none. The spec also says the flow is optimised entirely for draft quality, so
 * this sits in the middle rather than at either end. It is the one dial worth
 * turning if imports feel dear or drafts feel sloppy.
 */
const EFFORT = "medium" as const;

export interface DraftLine {
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  altQuantity: number | null;
  altUnit: string | null;
  /** Null when the model matched nothing — the line then needs a human answer. */
  ingredientId: number | null;
  ingredientName: string;
  sourceLine: string;
  /** The named part this belongs to, or null for the dish itself. */
  section: string | null;
  /** When parent-level content belongs in a multipart dish's cooking order. */
  phase: RecipePhase;
  /**
   * The alternative group this line is an option in, or null (#183). A page
   * saying "1 lihaliemikuutio tai 1 annos fondia" becomes two lines carrying
   * the same number, each with its own amount and its own ingredient.
   */
  alternativeGroup: AlternativeGroup;
  /**
   * The model's own doubt about this line, in one short Finnish sentence, or
   * null when it is sure. Null on nearly every line.
   *
   * This is what lets the import screen be a read view rather than a form: a
   * line worth a second look says so, instead of waiting to be found. It
   * describes the import, not the dish, so it is never saved.
   */
  note: string | null;
}

export interface DraftStep {
  text: string;
  section: string | null;
  phase: RecipePhase;
  /**
   * The ingredients this step mentions by name, pointing at this draft's own
   * lines (issue #120). Empty on nearly every producer: absent from the wire is
   * a valid draft, which is what keeps an older AgentDeck bundle importable.
   */
  refs: DraftIngredientRef[];
}

export interface Draft {
  title: string;
  yieldPortions: number | null;
  sourceText: string;
  steps: DraftStep[];
  lines: DraftLine[];
  structuredBy: string;
}

/** One photographed page, as it is handed to the model. */
export interface IntakeImage {
  base64: string;
  mediaType: string;
}

/**
 * How many pages one photographed import may carry. A printed recipe that
 * spills over a spread is the case this exists for (#156); the cap is here
 * rather than in `DRAFT_SCHEMA` because a count in the schema is a keyword
 * structured outputs refuses, and it stops every import at once.
 */
export const MAX_IMAGES = 8;

/**
 * The three routes in, and only three.
 *
 * A photographed import carries one *or more* pages, in the order the member
 * chose them, and they make one recipe rather than one each — a recipe printed
 * across a spread is read as the dish it is. Every page is held in memory for
 * the length of one model call and then dropped — never written to D1, and
 * there is no bucket.
 *
 * A linked import is text too, by the time it reaches here: `recipe-fetch.ts`
 * has already turned the address into the plainest reading of the page, and the
 * address rides along only so it can be saved on the recipe (#192). That is
 * what keeps there being one structuring path rather than a second importer.
 */
export type IntakeSource =
  | { route: "pasted"; text: string }
  | { route: "photographed"; images: IntakeImage[] }
  | { route: "linked"; url: string; text: string };

/** The model asked for. Exposed so a streamed draft can be stamped with it. */
export const STRUCTURED_BY = MODEL;

/**
 * What a member is told when an import fails and there is nothing more useful
 * to say. Every message a household reads is Finnish; the `Error.message` next
 * to it is English and goes to the log.
 */
const GENERIC_REFUSAL = "Reseptin jäsennys ei onnistunut. Yritä uudelleen.";

/** Thrown when the model failed in a way that re-running might fix. */
export class RetryableStructuringError extends Error {
  /** The Finnish sentence the screen shows. */
  readonly memberMessage: string;

  constructor(message: string, memberMessage: string = GENERIC_REFUSAL) {
    super(message);
    this.memberMessage = memberMessage;
  }
}

/**
 * The Finnish sentence for any import failure. An error that carries no
 * member-facing wording is a bug or an outage, and either way the household
 * only needs to know it can try again — the English detail is logged.
 */
export function importFailureMessage(error: unknown): string {
  console.log(JSON.stringify({
    event: "intake.failed",
    detail: String((error as Error)?.message ?? error),
  }));

  return error instanceof RetryableStructuringError
    ? error.memberMessage
    : GENERIC_REFUSAL;
}

/** How many times one import calls the model before it gives up. */
const ATTEMPTS = 2;

/** One newline-delimited record in the streamed draft protocol (#146, #153). */
export type DraftStreamRecord =
  | { type: "delta"; text: string }
  | { type: "restart" }
  | { type: "complete" }
  | { type: "failed" };

/**
 * Frame one stream event as an NDJSON record. Draft text lives inside a JSON
 * string, so pasted newlines or protocol-looking words cannot become records.
 */
export function encodeDraftStreamRecord(record: DraftStreamRecord): string {
  return `${JSON.stringify(record)}\n`;
}

const nullable = (type: string) => ({
  anyOf: [{ type }, { type: "null" }],
});

export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    yield_portions: nullable("integer"),
    source_text: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          section: nullable("string"),
          phase: {
            anyOf: [
              { type: "string", enum: ["before_parts", "after_parts"] },
              { type: "null" },
            ],
          },
          // Issue #120: which words in `text` name which of this draft's own
          // ingredient lines. A pointer and the wording, never an amount.
          // The cap lives in the prompt and in assertDraftWire, not here:
          // structured outputs reject `maxItems`, and the whole request 400s
          // if it is present — see dev/check-draft-schema.ts.
          ingredient_refs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                line: { type: "integer" },
                matched_text: { type: "string" },
                approx_position: { type: "integer" },
              },
              required: ["line", "matched_text", "approx_position"],
              additionalProperties: false,
            },
          },
        },
        required: ["text", "section", "phase", "ingredient_refs"],
        additionalProperties: false,
      },
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quantity: nullable("number"),
          quantity_max: nullable("number"),
          unit: nullable("string"),
          alt_quantity: nullable("number"),
          alt_unit: nullable("string"),
          ingredient_id: nullable("integer"),
          ingredient_name: { type: "string" },
          source_line: { type: "string" },
          section: nullable("string"),
          phase: {
            anyOf: [
              { type: "string", enum: ["before_parts", "after_parts"] },
              { type: "null" },
            ],
          },
          alternative_group: nullable("integer"),
          note: nullable("string"),
        },
        required: [
          "quantity",
          "quantity_max",
          "unit",
          "alt_quantity",
          "alt_unit",
          "ingredient_id",
          "ingredient_name",
          "source_line",
          "section",
          "phase",
          "alternative_group",
          "note",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "yield_portions", "source_text", "steps", "lines"],
  additionalProperties: false,
} as const;

/**
 * Extra standing rules for a photographed page. There is no given text, so
 * source_text becomes the model's own transcription — and that transcription is
 * what gets kept forever as the record of what arrived.
 */
const PHOTOGRAPHED_RULES = `
Kuvatun sivun lisäsäännöt:

- source_text on oma tarkka transkriptio kuvasta sellaisenaan; älä siivoa,
  järjestä uudelleen, käännä tai tiivistä.
- Litteroi vain se, mikä on oikeasti luettavissa; älä arvaa sumeita tai
  rajautuneita sanoja.
- Ainesosarivit ja vaiheet johdetaan samasta transkriptiosta, ei kuvasta
  erikseen tulkiten.
- Jos sivulla on useampi resepti, poimi vain pääresepti.
- Ohita sivun oheismateriaali: sivunumerot, otsikkotunnisteet, mainokset ja
  aiheeseen liittymättömät kuvatekstit.
- Jos kuva on epäselvä tai osa tekstistä puuttuu, jätä vastaava kenttä null sen
  sijaan että täydentäisit sen arvauksella.
`;

/**
 * The rules that only apply once there is more than one page. They say the one
 * thing a multi-page import can get catastrophically wrong: reading a spread as
 * two dishes rather than as one dish that ran out of room.
 */
const MULTIPAGE_RULES = `
Monisivuisen reseptin lisäsäännöt:

- Sivut ovat saman reseptin peräkkäisiä sivuja siinä järjestyksessä kuin ne on
  annettu. Niistä syntyy täsmälleen yksi resepti, ei sivukohtaisia reseptejä.
- source_text on kaikkien sivujen transkriptio peräkkäin samassa järjestyksessä.
- Jos ainesluettelo on yhdellä sivulla ja vaiheet toisella, ne kuuluvat samaan
  reseptiin; älä toista eikä pudota kumpaakaan.
- Jos sama teksti näkyy kahdella sivulla, kirjoita se vain kerran.
- Jos jollakin sivulla on jokin muu resepti, ohita se ja pysy pääreseptissä.
`;

/**
 * Extra standing rules for text read off a web page (#192).
 *
 * The text arrived from a machine rather than from a person, so unlike a paste
 * it may still carry the page around the recipe — a cookie notice, a comment,
 * a list of other dishes. `recipe-fetch.ts` removes what it safely can; these
 * rules say what to do with whatever survived.
 */
const LINKED_RULES = `
Nettisivulta luetun tekstin lisäsäännöt:

- Teksti on poimittu nettisivulta koneellisesti, joten mukana voi olla sivun
  muuta sisältöä: valikoita, evästeilmoituksia, mainoksia, kommentteja tai
  linkkejä toisiin resepteihin. Poimi vain sivun pääresepti.
- Jos sivulla on useampi resepti, valitse se, jonka otsikko ja ainesluettelo
  ovat tekstin alussa, ja jätä loput huomiotta.
- source_text on annettu teksti sellaisenaan. Älä siivoa, järjestä uudelleen,
  käännä tai tiivistä sitä.
- Älä ota mukaan kommenttien tai arvostelujen ehdottamia muutoksia. Resepti on
  se, minkä sivu itse kertoo.
- Jos jokin tieto puuttuu tekstistä, jätä kenttä null. Älä täydennä sitä
  yleistiedolla ruokalajista.
`;

/** The standing rules, from docs/spec.md's intake flow. */
function systemPrompt(
  ingredients: IngredientSummary[],
  source: IntakeSource,
): string {
  const list = ingredients
    .map((ingredient) => `${ingredient.id}\t${ingredient.name}`)
    .join("\n");

  const extra =
    source.route === "photographed"
      ? PHOTOGRAPHED_RULES + (source.images.length > 1 ? MULTIPAGE_RULES : "")
      : source.route === "linked"
        ? LINKED_RULES
        : "";

  return `Rakennat suomenkielisestä reseptistä jäsennellyn reseptin.

Säännöt, joista ei poiketa:

- Älä koskaan keksi määrää tai yksikköä. Jos teksti ei sano, jätä null.
- Säilytä yksikkö täsmälleen sellaisena kuin resepti sen kirjoitti (dl, rkl, tl, kpl, g).
- Kopioi jokainen source_line sanatarkasti sellaisena kuin se rivillä lukee.
- Aseta quantity_max vain kun rivi todella ilmaisee välin, myös sanoin
  kirjoitettuna ("1–1 ja ½ l"). Muuten null.
- Käytä alt_quantity ja alt_unit kun rivi mittaa saman asian kahdesti eri
  yksiköissä ("½ (500 g) valkokaali"). Säilytä lähteen kirjoitusjärjestys.
  Molemmat tai ei kumpaakaan.
- Kun rivi tarjoaa vaihtoehtoja ("1 lihaliemikuutio tai 1 annos fondia",
  "voita tai margariinia"), kirjoita jokainen vaihtoehto omaksi rivikseen ja
  anna niille sama alternative_group-numero. Numerot alkavat ykkösestä ja
  kasvavat reseptin sisällä. Jokaisella vaihtoehdolla on oma quantity ja unit
  sen mukaan mitä teksti sanoo, ja oma ingredient_name — älä koskaan kirjoita
  "hunaja tai sokeri" yhdeksi ainekseksi. source_line on kaikilla saman ryhmän
  riveillä sama alkuperäinen rivi sanatarkasti. Ryhmässä on aina vähintään kaksi
  riviä; muuten alternative_group on null. Saman ryhmän riveillä on aina sama
  section ja sama phase — vaihtoehdot käytetään samassa kohdassa, joten ryhmä ei
  jakaudu kahteen osaan eikä ennen/jälkeen-vaiheeseen.
- Aseta yield_portions vain jos teksti kertoo annosmäärän.
- source_text on annettu teksti sellaisenaan.
- Yhdistä jokainen rivi olemassa olevaan ainekseen sen id:llä kun jokin selvästi
  sopii. Muuten jätä ingredient_id null ja ehdota nimi ingredient_name-kentässä.
- Jos ruokalaji on kirjoitettu nimettyihin osiin — kuten lasagnen
  jauhelihakastike ja juustokastike — merkitse jokaisen rivin ja vaiheen
  section-kenttään sen osan nimi täsmälleen kuten se sivulla lukee. Jos rivi tai
  vaihe ei kuulu mihinkään osaan, jätä section null. Älä keksi osia: jos
  sivulla ei ole väliotsikoita, kaikki section-kentät ovat null.
- Kun reseptissä on nimettyjä osia, luokittele jokainen section null -rivi ja
  -vaihe ruoanlaittojärjestyksen mukaan. phase on before_parts, kun työ tehdään
  ennen nimettyjä osia, ja after_parts, kun se on kokoamista, yhdistämistä,
  paistamista, viimeistelyä tai tarjoilua osien jälkeen. Nimetyn osan sisällön
  phase on null. Ilman nimettyjä osia kaikkien phase on null.
- Aseta note vain kun rivistä oikeasti katosi tai arvattiin jotain: jouduit
  päättelemään yksikön, määrä oli sanallinen, rivillä oli vaihtoehto tai
  valmistustapa jota kentät eivät kanna, tai teksti oli epäselvä. Kirjoita
  yhdellä lyhyellä suomenkielisellä lauseella mikä jäi auki.
  Note on huomiolista, ei selostus: yhdessä reseptissä niitä on tyypillisesti
  nolla tai yksi. Jos merkitsisit yli puolet riveistä, merkitse vain ne joissa
  tietoa todella katosi, ja jätä muut nulliksi. Rivi jonka luit suoraan oikein
  ei koskaan saa notea.
- Merkitse jokaisen vaiheen ingredient_refs-kenttään ne kohdat, joissa vaiheen
  teksti nimeää jonkin tämän reseptin ainesrivin. line on sen ainesrivin
  järjestysnumero lines-taulukossa, ensimmäinen rivi on 0. matched_text on
  täsmälleen se sanamuoto, joka vaiheen tekstissä lukee, taivutus mukaan lukien
  ("tomaatit", ei "tomaatti"). approx_position on sen sanan alkukohta vaiheen
  tekstissä merkkeinä laskettuna, ensimmäinen merkki on 0; likiarvo riittää.
  Tunnista tavallinen suomen taivutus ja sanamuotojen vaihtelu: "tomaatti"
  voi esiintyä muodossa "tomaatit" tai "tomaatteja".
  Näistä ei poiketa:
  - älä keksi ainesriviä jota lines-taulukossa ei ole, äläkä viittaa toisen
    osan riviin — vaihe viittaa vain oman section-arvonsa riveihin;
  - älä koskaan kirjoita määrää tai yksikköä matched_text-kenttään; määrä
    luetaan aina ainesriviltä;
  - älä muuta vaiheen tekstiä millään tavalla;
  - yleisiä ilmauksia kuten "lisää loput ainekset" ei tarvitse yhdistää
    mihinkään. Jos vaihe ei nimeä yhtään ainesta, ingredient_refs on [];
  - yhdessä vaiheessa on enintään ${MAX_REFS_PER_STEP} viittausta.
${extra}
Talouden hyväksytyt ainekset (id, nimi):

${list || "(ei vielä yhtään)"}`;
}

/**
 * What the model is handed: a block of text, or the photographed pages in the
 * order the member chose them.
 *
 * Each page after the first is announced by a short line of its own before the
 * picture, because that is how a model is told which image is which — with
 * several unlabelled images it has no way to say "the second page" back. A
 * single page is worded exactly as it was before pages were plural, so the
 * one-photo import is not quietly a different prompt.
 */
function userContent(source: IntakeSource) {
  if (source.route === "pasted" || source.route === "linked") {
    return source.text;
  }

  const pages = source.images;
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: "image/jpeg"; data: string };
      }
  > = [];

  pages.forEach((image, index) => {
    if (pages.length > 1) {
      content.push({
        type: "text",
        text: `Sivu ${index + 1}/${pages.length}:`,
      });
    }
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mediaType as "image/jpeg",
        data: image.base64,
      },
    });
  });

  content.push({
    type: "text",
    text:
      pages.length > 1
        ? `Jäsennä näiden ${pages.length} sivun resepti. Sivut ovat saman reseptin osia annetussa järjestyksessä.`
        : "Jäsennä tämän sivun resepti.",
  });

  return content;
}

/**
 * The text a draft's source_text should hold: for a paste or a fetched page,
 * exactly what arrived; for a photograph, the model's transcription, since
 * nothing else records what was on the page.
 */
function keptSourceText(source: IntakeSource, transcribed: unknown): string {
  if (source.route === "pasted" || source.route === "linked") return source.text;
  return typeof transcribed === "string" ? transcribed : "";
}

/**
 * Refuse a response that stopped for a reason other than being finished.
 *
 * A draft cut off at `max_tokens` is still valid JSON as far as the transport
 * is concerned — it just ends mid-document — and a refusal produces no text at
 * all. Both used to reach the browser looking like a completed import, which
 * is how a truncated draft became "the model returned unparseable JSON" three
 * screens later.
 */
function assertFinished(stopReason: string | null): void {
  if (stopReason === "refusal") {
    throw new Error(
      "The model declined to structure this text.",
    );
  }
  if (stopReason === "max_tokens") {
    throw new RetryableStructuringError(
      "The draft was cut off at max_tokens.",
      "Resepti oli niin pitkä, että jäsennys katkesi kesken. " +
        "Kokeile kuvata tai liittää vain yhden reseptin verran kerrallaan.",
    );
  }
}

/**
 * The draft as a stream of bytes.
 *
 * Bytes never stop flowing, so Cloudflare's ~125 s proxy cutoff never fires —
 * this is the whole reason the stack is Workers (#7). It also makes a slow
 * import feel like progress rather than a hang.
 */
export function streamDraft(
  env: Env,
  source: IntakeSource,
  ingredients: IngredientSummary[],
): ReadableStream<Uint8Array> {
  const client = anthropic(env);
  return draftStream(
    () => client.messages.stream({ ...requestFor(source, ingredients) }),
    source,
  );
}

/**
 * As much of a streaming model response as the attempt loop reads. It is
 * deliberately the smallest shape that both the SDK's stream and a fake in
 * `dev/check-intake-stream.ts` satisfy, which is why `delta` is left unknown
 * here and narrowed in `textDelta` — the SDK's own event union is far wider
 * than anything this loop cares about.
 */
export interface DraftAttemptStream
  extends AsyncIterable<{ type: string; delta?: unknown }> {
  finalMessage(): Promise<{
    model?: string;
    stop_reason?: string | null;
    content: Array<{ type: string; text?: string }>;
    usage?: unknown;
  }>;
}

/** The text a streamed event carries, or null when it carries none. */
function textDelta(event: { type: string; delta?: unknown }): string | null {
  if (event.type !== "content_block_delta") return null;
  const delta = event.delta as { type?: string; text?: string } | undefined;
  return delta?.type === "text_delta" ? delta.text ?? "" : null;
}

/**
 * The attempt loop behind `streamDraft`, with the model call handed in so it
 * can be driven without spending anything (`dev/check-intake-stream.ts`).
 *
 * It gives the streaming path the error tolerance the plain path has had all
 * along in `structureDraftWithRetry`: a cut-off or unparseable answer is
 * retried once, and either way the browser is told which it got. The two
 * attempts are separated by a `restart` record, so their JSON cannot be read
 * as one draft however the bytes happen to be chunked.
 */
export function draftStream(
  startAttempt: () => DraftAttemptStream,
  source: IntakeSource,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const emit = (record: DraftStreamRecord) =>
        controller.enqueue(encoder.encode(encodeDraftStreamRecord(record)));

      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        if (attempt > 0) emit({ type: "restart" });

        try {
          await runAttempt(startAttempt(), source, emit);
          emit({ type: "complete" });
          controller.close();
          return;
        } catch (cause) {
          const retry =
            attempt < ATTEMPTS - 1 && cause instanceof RetryableStructuringError;
          console.log(JSON.stringify({
            event: "intake.attempt_failed",
            attempt: attempt + 1,
            retrying: retry,
            reason: String((cause as Error).message ?? cause),
          }));
          if (retry) continue;

          // The English detail of the last attempt, logged the same way every
          // other import failure is, so `wrangler tail` shows one shape.
          importFailureMessage(cause);

          // The stream is closed rather than torn down: a terminal record the
          // browser can read stops it handing a half-draft to /intake/correct.
          emit({ type: "failed" });
          controller.close();
          return;
        }
      }
    },
  });
}

/**
 * Stream one model attempt through to the browser, then check it the way
 * `structureDraft` checks a non-streamed one. Throwing here means the bytes
 * already sent are worthless, which is what the caller's records announce.
 */
async function runAttempt(
  stream: DraftAttemptStream,
  source: IntakeSource,
  emit: (record: DraftStreamRecord) => void,
): Promise<void> {
  let text = "";
  let response: Awaited<ReturnType<DraftAttemptStream["finalMessage"]>>;

  try {
    for await (const event of stream) {
      const delta = textDelta(event);
      if (delta === null) continue;
      text += delta;
      emit({ type: "delta", text: delta });
    }

    response = await stream.finalMessage();
  } catch (cause) {
    throw new RetryableStructuringError(`Model call failed: ${String(cause)}`);
  }

  logImportUsage(
    recipeTitle(response.content, text),
    response.usage,
    response.stop_reason,
  );

  // A refusal is not worth calling again and a cut-off answer is; both carry
  // their own Finnish wording, which is why this is not two inline checks.
  assertFinished(response.stop_reason ?? null);

  // Parsed here, on the server, and the result thrown away — the browser hands
  // the same text back to /intake/correct, which parses it for real. What this
  // buys is that an unparseable attempt is a retry rather than a member staring
  // at "The model returned unparseable JSON."
  draftFromJson(text, source, response.model ?? STRUCTURED_BY);
}

/**
 * Record the cost-bearing part of a completed model response, and why it
 * stopped — without the stop reason, a truncated import is indistinguishable
 * from a finished one in the log.
 */
export function logImportUsage(
  title: string | null,
  usage: unknown,
  stopReason?: string | null,
): void {
  console.log(JSON.stringify({
    event: "intake.model_usage",
    recipe_title: title,
    usage,
    stop_reason: stopReason ?? undefined,
  }));
}

function recipeTitle(
  content: Array<{ type: string; text?: string }>,
  streamedText?: string,
): string | null {
  const text = streamedText ?? content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

  try {
    const parsed = JSON.parse(text) as { title?: unknown };
    return typeof parsed.title === "string" ? parsed.title : null;
  } catch {
    return null;
  }
}

/** Parse a draft the browser streamed and handed back. */
export function draftFromJson(
  text: string,
  source: IntakeSource,
  model: string,
): Draft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RetryableStructuringError(
      text.trim() === ""
        ? "The browser handed back an empty draft."
        : "The model returned unparseable JSON.",
    );
  }

  assertDraftWire(raw);
  return toDraft(raw, source, model);
}

/**
 * Enforce the same wire contract for every producer of a draft. Structured
 * model output is constrained by DRAFT_SCHEMA, but browser handoff and
 * AgentDeck bundles are still untrusted JSON by the time they reach here.
 */
function assertDraftWire(raw: unknown): void {
  const draft = objectWithKeys(raw, "draft", [
    "title",
    "yield_portions",
    "source_text",
    "steps",
    "lines",
  ]);
  requireString(draft["title"], "title");
  requireWholeOrNull(draft["yield_portions"], "yield_portions");
  requireString(draft["source_text"], "source_text");

  if (!Array.isArray(draft["steps"])) invalid("steps must be an array");
  draft["steps"].forEach((rawStep, index) => {
    const step = objectWithKeys(
      rawStep,
      `steps[${index}]`,
      ["text", "section", "phase"],
      // Optional: a bundle written before issue #120 links no ingredients, and
      // refusing it would break every draft AgentDeck has already generated.
      ["ingredient_refs"],
    );
    requireString(step["text"], `steps[${index}].text`);
    requireStringOrNull(step["section"], `steps[${index}].section`);
    requirePhase(step["phase"], `steps[${index}].phase`);
    requireStepRefs(step["ingredient_refs"], `steps[${index}].ingredient_refs`);
  });

  if (!Array.isArray(draft["lines"])) invalid("lines must be an array");
  draft["lines"].forEach((rawLine, index) => {
    const line = objectWithKeys(rawLine, `lines[${index}]`, [
      "quantity",
      "quantity_max",
      "unit",
      "alt_quantity",
      "alt_unit",
      "ingredient_id",
      "ingredient_name",
      "source_line",
      "section",
      "phase",
      "note",
    ],
    // Optional: a bundle written before issue #183 offers no alternatives, and
    // refusing it would break every draft AgentDeck has already generated.
    ["alternative_group"]);
    requireNumberOrNull(line["quantity"], `lines[${index}].quantity`);
    requireNumberOrNull(line["quantity_max"], `lines[${index}].quantity_max`);
    requireStringOrNull(line["unit"], `lines[${index}].unit`);
    requireNumberOrNull(line["alt_quantity"], `lines[${index}].alt_quantity`);
    requireStringOrNull(line["alt_unit"], `lines[${index}].alt_unit`);
    const altQuantity = line["alt_quantity"];
    const altUnit = textOrNull(line["alt_unit"]);
    if ((altQuantity === null) !== (altUnit === null)) {
      invalid(
        `lines[${index}].alt_quantity and alt_unit must both be set or both be null`,
      );
    }
    if (altQuantity !== null && line["quantity"] === null) {
      invalid(`lines[${index}].alternative measurement requires quantity`);
    }
    requireWholeOrNull(line["ingredient_id"], `lines[${index}].ingredient_id`);
    requireString(line["ingredient_name"], `lines[${index}].ingredient_name`);
    requireString(line["source_line"], `lines[${index}].source_line`);
    requireStringOrNull(line["section"], `lines[${index}].section`);
    requirePhase(line["phase"], `lines[${index}].phase`);
    requireAlternativeGroup(
      line["alternative_group"],
      `lines[${index}].alternative_group`,
    );
    requireStringOrNull(line["note"], `lines[${index}].note`);
  });
}

function objectWithKeys(
  value: unknown,
  label: string,
  keys: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const expected = new Set([...keys, ...optional]);
  for (const key of keys) {
    if (!(key in object)) invalid(`${label}.${key} is required`);
  }
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) invalid(`${label}.${key} is not allowed`);
  }
  return object;
}

function requireString(value: unknown, label: string): void {
  if (typeof value !== "string") invalid(`${label} must be a string`);
}

function requireStringOrNull(value: unknown, label: string): void {
  if (value !== null && typeof value !== "string") {
    invalid(`${label} must be a string or null`);
  }
}

function requireNumberOrNull(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    invalid(`${label} must be a number or null`);
  }
}

/** A group is a positive whole number when it is there at all. */
function requireAlternativeGroup(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${label} must be a positive integer or null`);
  }
}

function requireWholeOrNull(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    invalid(`${label} must be an integer or null`);
  }
}

/**
 * A step's ingredient references, if it carries any. The shape is checked
 * strictly, like every other field — but *which* line a reference points at and
 * whether its wording is really in the step are settled in `toDraft`, where the
 * rest of the draft is in hand, and a reference that fails there is dropped
 * rather than refused. A mislinked word is a small loss; refusing the whole
 * import over one would not be.
 */
function requireStepRefs(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  if (value.length > MAX_REFS_PER_STEP) {
    invalid(`${label} may hold at most ${MAX_REFS_PER_STEP} references`);
  }

  value.forEach((rawRef, index) => {
    const ref = objectWithKeys(rawRef, `${label}[${index}]`, [
      "line",
      "matched_text",
      "approx_position",
    ]);
    requireWhole(ref["line"], `${label}[${index}].line`);
    requireString(ref["matched_text"], `${label}[${index}].matched_text`);
    requireWhole(ref["approx_position"], `${label}[${index}].approx_position`);
  });
}

function requireWhole(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a whole number that is not negative`);
  }
}

function requirePhase(value: unknown, label: string): void {
  if (value !== null && value !== "before_parts" && value !== "after_parts") {
    invalid(`${label} is not a supported phase`);
  }
}

function invalid(message: string): never {
  throw new RetryableStructuringError(`Invalid draft: ${message}.`);
}

function anthropic(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * The whole model request for one source. Exported so `dev/check-intake-images.ts`
 * can assert what a multi-page import actually asks the model — the page order
 * and the one-recipe rule are the parts of this change a paid call would
 * otherwise be the only way to see.
 */
export function requestFor(source: IntakeSource, ingredients: IngredientSummary[]) {
  return {
    model: MODEL,
    // The model's own ceiling, counted across thinking *and* the draft. It is
    // a limit rather than a spend, so nothing costs more for it being high —
    // but a budget this large is why both calls have to stream.
    max_tokens: 128000,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema" as const, schema: DRAFT_SCHEMA },
    },
    system: systemPrompt(ingredients, source),
    messages: [{ role: "user" as const, content: userContent(source) }],
  };
}

function toDraft(raw: unknown, source: IntakeSource, model: string): Draft {
  if (typeof raw !== "object" || raw === null) {
    throw new RetryableStructuringError("The draft was not an object.");
  }

  const draft = raw as Record<string, unknown>;
  const rawLines = Array.isArray(draft["lines"]) ? draft["lines"] : [];
  const rawSteps = Array.isArray(draft["steps"]) ? draft["steps"] : [];
  const lines = rawLines.map(toDraftLine);

  return {
    title: typeof draft["title"] === "string" ? draft["title"] : "",
    yieldPortions: wholeOrNull(draft["yield_portions"]),
    sourceText: keptSourceText(source, draft["source_text"]),
    steps: rawSteps
      .map((step) => toDraftStep(step, lines))
      .filter((step) => step.text !== ""),
    lines,
    structuredBy: model,
  };
}

function toDraftStep(raw: unknown, lines: DraftLine[]): DraftStep {
  const step = (raw ?? {}) as Record<string, unknown>;
  const text = typeof step["text"] === "string" ? step["text"].trim() : "";
  const section = textOrNull(step["section"]);

  return {
    text,
    section,
    phase: recipePhase(step["phase"]),
    refs: toDraftRefs(step["ingredient_refs"], text, section, lines),
  };
}

/**
 * The step's ingredient references, keeping only the ones that are safe to act
 * on. A reference is dropped, never refused, when it points past the end of the
 * ingredient list, when it points into a different part of the dish than the
 * step itself, or when the wording it claims to have matched is not in the step
 * at all. Every one of those is a producer having got something slightly wrong,
 * and the recipe is worth more than the link.
 */
function toDraftRefs(
  raw: unknown,
  text: string,
  section: string | null,
  lines: DraftLine[],
): DraftIngredientRef[] {
  if (!Array.isArray(raw)) return [];

  const refs: DraftIngredientRef[] = [];

  for (const entry of raw.slice(0, MAX_REFS_PER_STEP)) {
    const ref = (entry ?? {}) as Record<string, unknown>;
    const lineIndex = wholeOrNull(ref["line"]);
    const matchedText =
      typeof ref["matched_text"] === "string" ? ref["matched_text"] : "";
    const approxPosition = wholeOrNull(ref["approx_position"]);

    if (lineIndex === null || lineIndex < 0 || lineIndex >= lines.length) {
      continue;
    }
    if ((lines[lineIndex]?.section ?? null) !== section) continue;
    if (!mentionResolves(text, matchedText)) continue;

    refs.push({
      lineIndex,
      matchedText,
      approxPosition: Math.max(0, approxPosition ?? 0),
      // An import has no ingredient to expect: the line this points at may not
      // be a row in the household's list until the save creates one.
      expectedIngredientId: null,
    });
  }

  return refs;
}

function toDraftLine(raw: unknown): DraftLine {
  const line = (raw ?? {}) as Record<string, unknown>;

  const quantity = numberOrNull(line["quantity"]);
  const altQuantity = numberOrNull(line["alt_quantity"]);
  const altUnit = textOrNull(line["alt_unit"]);

  // The schema's two rules, enforced again here: a second measurement is both
  // halves or neither, and never stands alone.
  const altPairIsWhole = altQuantity !== null && altUnit !== null;

  return {
    quantity,
    quantityMax: numberOrNull(line["quantity_max"]),
    unit: textOrNull(line["unit"]),
    altQuantity: altPairIsWhole && quantity !== null ? altQuantity : null,
    altUnit: altPairIsWhole && quantity !== null ? altUnit : null,
    ingredientId: wholeOrNull(line["ingredient_id"]),
    note: textOrNull(line["note"]),
    ingredientName:
      typeof line["ingredient_name"] === "string" ? line["ingredient_name"] : "",
    sourceLine:
      typeof line["source_line"] === "string" ? line["source_line"] : "",
    section: textOrNull(line["section"]),
    phase: recipePhase(line["phase"]),
    alternativeGroup: alternativeGroup(line["alternative_group"]),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function wholeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
