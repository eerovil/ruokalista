import assert from "node:assert/strict";
import test from "node:test";

import {
  collectValidatedDraft,
  createIntakeJob,
  IntakeRefused,
  MAX_IMPORT_GUIDANCE,
  maintainIntakeJobs,
  processIntakeJob,
  processIntakeQueue,
} from "../src/intake-jobs.ts";
import {
  encodeDraftStreamRecord,
  MAX_PAGE_BASE64_BYTES,
  MAX_PAGES_BASE64_BYTES,
} from "../src/intake.ts";
import { SAMPLE_DRAFT } from "../src/sample-draft.ts";
import { png } from "./support/images.ts";

test("the queued consumer keeps only the validated retry attempt", async () => {
  const body = [
    encodeDraftStreamRecord({ type: "delta", text: '{"title":"Katkennut"' }),
    encodeDraftStreamRecord({ type: "restart" }),
    encodeDraftStreamRecord({ type: "delta", text: '{"title":"Pöperö","source_text":"½ tl"}' }),
    encodeDraftStreamRecord({ type: "complete" }),
  ].join("");

  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split inside both an NDJSON record and the Finnish multibyte text.
      for (const [from, to] of [[0, 7], [7, 61], [61, 83], [83, bytes.length]]) {
        controller.enqueue(bytes.slice(from, to));
      }
      controller.close();
    },
  });

  assert.equal(
    await collectValidatedDraft(stream),
    '{"title":"Pöperö","source_text":"½ tl"}',
  );
});

test("a failed or abruptly ended model stream never becomes a ready draft", async () => {
  const failed = streamOf(
    encodeDraftStreamRecord({ type: "delta", text: "half" }) +
      encodeDraftStreamRecord({ type: "failed" }),
  );
  await assert.rejects(collectValidatedDraft(failed), /did not produce a draft/);

  await assert.rejects(
    collectValidatedDraft(streamOf('{"type":"delta","text":"half"}\n')),
    /ended without a completed draft/,
  );
});

test("duplicate deliveries acknowledge one paid operation", async () => {
  let ready = false;
  let modelCalls = 0;
  const messages = [message(1), message(1)];

  await processIntakeQueue(batch(messages), {} as never, {
    process: async () => {
      if (ready) return "done";
      modelCalls += 1;
      ready = true;
      return "done";
    },
  });

  assert.equal(modelCalls, 1);
  assert.deepEqual(messages.map((item) => item.actions), [["ack"], ["ack"]]);
});

test("an exhausted queue delivery becomes a retryable failed job", async () => {
  const early = message(1);
  const final = message(20);
  const failed: string[] = [];

  await processIntakeQueue(batch([early, final]), {} as never, {
    process: async () => { throw new Error("D1 temporarily unavailable"); },
    reconcile: async (_db, id) => {
      failed.push(id);
      return "done";
    },
  });

  assert.deepEqual(early.actions, ["retry:60"]);
  assert.deepEqual(final.actions, ["ack"]);
  assert.deepEqual(failed, ["job-20"]);
});

test("an exhausted duplicate keeps retrying while another lease is live", async () => {
  const final = message(20);
  await processIntakeQueue(batch([final]), {} as never, {
    process: async () => { throw new Error("claim read failed"); },
    reconcile: async () => "busy",
  });
  assert.deepEqual(final.actions, ["retry:60"]);
});

/**
 * Issue #218 asks that an import too large to carry says so in Finnish rather
 * than failing somewhere with nothing a household can read. The browser holds
 * the same two limits, so reaching these means something sent pages the import
 * screen never prepared.
 */
test("photographed pages too large to carry are refused in Finnish", async () => {
  const stored: string[] = [];
  const env = {
    DB: { prepare: () => { throw new Error("nothing may be written"); } },
    RECIPE_IMAGES: { put: async (key: string) => { stored.push(key); } },
    INTAKE_QUEUE: { send: async () => {} },
  } as unknown as import("../src/env.ts").Env;
  const member = { id: 1, householdId: 1 } as unknown as import("../src/members.ts").Member;

  const page = (bytes: number) => ({ image: "A".repeat(bytes), mediaType: "image/jpeg" });

  await assert.rejects(
    createIntakeJob(env, member, { images: [page(MAX_PAGE_BASE64_BYTES + 1)] }),
    (error: Error) =>
      error instanceof IntakeRefused
      && error.message === "Yksi kuvista on liian suuri lähetettäväksi. Ota se uudelleen.",
  );

  // Under the per-page limit each, over it together.
  const each = Math.ceil(MAX_PAGES_BASE64_BYTES / 3);
  await assert.rejects(
    createIntakeJob(env, member, { images: [page(each), page(each), page(each), page(each)] }),
    (error: Error) =>
      error instanceof IntakeRefused
      && error.message === "Kuvat ovat yhteensä liian suuria. Poista jokin sivu ja yritä uudelleen.",
  );

  // Refused before anything was written, so a refusal leaves no orphan behind.
  assert.deepEqual(stored, []);
});

test("four ordinary photographed pages are not refused for their size", async () => {
  const written: string[] = [];
  const enqueued: string[] = [];
  const env = intakeDatabase({ source_route: "photographed", source_text: null });
  const bucket = { put: async (key: string) => { written.push(key); } };

  // What the import screen really produces: about 400 kB of base64 a page.
  const pages = [1, 2, 3, 4].map(() => ({
    image: "A".repeat(400 * 1024),
    mediaType: "image/jpeg",
  }));

  await createIntakeJob(
    {
      ...env.env,
      RECIPE_IMAGES: bucket,
      INTAKE_QUEUE: { send: async ({ jobId }: { jobId: string }) => { enqueued.push(jobId); } },
    } as unknown as import("../src/env.ts").Env,
    { id: 1, householdId: 1 } as unknown as import("../src/members.ts").Member,
    { images: pages },
  );

  assert.equal(written.length, 4);
  assert.equal(enqueued.length, 1);
});

test("overlong linked guidance is refused before a job is written", async () => {
  const env = {
    DB: { prepare: () => { throw new Error("nothing may be written"); } },
    RECIPE_IMAGES: {},
    INTAKE_QUEUE: {},
  } as unknown as import("../src/env.ts").Env;

  await assert.rejects(
    createIntakeJob(
      env,
      { id: 1, householdId: 1 } as unknown as import("../src/members.ts").Member,
      {
        url: "https://kotikokki.example/uunikaali",
        guidance: "x".repeat(MAX_IMPORT_GUIDANCE + 1),
      },
    ),
    (error: Error) =>
      error instanceof IntakeRefused &&
      error.message === `Lisäohje voi olla enintään ${MAX_IMPORT_GUIDANCE} merkkiä.`,
  );
});

test("maintenance recreates lost messages and deletes only real R2 orphans", async () => {
  const sent: string[] = [];
  const deleted: string[] = [];
  const prepared: string[] = [];
  const day = 24 * 60 * 60 * 1000;
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      const statement = {
        bind: (..._values: unknown[]) => statement,
        run: async () => ({ meta: { changes: 1 } }),
        all: async () => {
          if (sql.includes("SELECT id, status")) {
            return { results: [
              { id: "stale", status: "running" },
              { id: "lost", status: "queued" },
            ] };
          }
          return {
            results: [{ image_refs: JSON.stringify([
              { key: "intake/referenced/1", mediaType: "image/jpeg" },
            ]) }],
          };
        },
      };
      return statement;
    },
  };
  const bucket = {
    list: async () => ({
      objects: [
        { key: "intake/referenced/1", uploaded: new Date(Date.now() - 2 * day) },
        { key: "intake/orphan-old/1", uploaded: new Date(Date.now() - 2 * day) },
        { key: "intake/orphan-new/1", uploaded: new Date() },
      ],
      truncated: false,
    }),
    delete: async (key: string) => { deleted.push(key); },
  };

  await maintainIntakeJobs({
    DB: db,
    INTAKE_QUEUE: { send: async ({ jobId }: { jobId: string }) => { sent.push(jobId); } },
    RECIPE_IMAGES: bucket,
  } as unknown as import("../src/env.ts").Env);

  assert.deepEqual(sent, ["stale", "lost"]);
  assert.deepEqual(deleted, ["intake/orphan-old/1"]);
  assert.ok(prepared.some((sql) => sql.includes("SET status = 'queued', lease_id = NULL")));
});

test("only the lease that claimed a job can make it ready or failed", async () => {
  const ready = intakeDatabase();
  await processIntakeJob(ready.env, "owned", {
    structure: async () => JSON.stringify(SAMPLE_DRAFT),
  });
  assert.equal(ready.claimLease(), ready.readyLease());
  assert.equal(ready.failedLease(), null);

  const failed = intakeDatabase();
  await processIntakeJob(failed.env, "owned", {
    structure: async () => { throw new Error("model transport failed"); },
  });
  assert.equal(failed.claimLease(), failed.failedLease());
  assert.equal(failed.readyLease(), null);
});

const RECIPE_PAGE = `<!doctype html><html><head><title>Uunikaali</title>
  <script type="application/ld+json">${JSON.stringify({
    "@type": "Recipe",
    name: "Uunikaali",
    recipeYield: "4 annosta",
    recipeIngredient: ["500 g valkokaalia", "1 l vettä", "\u00bd dl \u00f6ljy\u00e4"],
    recipeInstructions: "Kuullota kaali pannulla ja paista uunissa tunnin ajan.",
  })}</script></head>
  <body><main><h1>Uunikaali</h1></main></body></html>`;

test("a linked job reads its page in the consumer, not in the request", async () => {
  const db = intakeDatabase({
    source_route: "linked",
    source_text: null,
    source_url: "https://kotikokki.example/uunikaali",
    import_guidance: "Sivulla on kaksi reseptiä; lue vain alempi.",
  });
  const server = pageServer(RECIPE_PAGE);

  let given: unknown = null;
  await processIntakeJob(db.env, "owned", {
    fetchPage: server.fetchPage,
    structure: async (_env, job, source) => {
      given = job;
      assert.equal(source.route, "linked");
      if (source.route === "linked") {
        assert.equal(source.url, "https://kotikokki.example/uunikaali");
        assert.match(source.text, /valkokaalia/);
        assert.equal(
          source.guidance,
          "Sivulla on kaksi reseptiä; lue vain alempi.",
        );
      }
      return JSON.stringify(SAMPLE_DRAFT);
    },
  });

  // The site was read once, by the queue consumer.
  assert.deepEqual(server.requests(), ["https://kotikokki.example/uunikaali"]);
  assert.notEqual(given, null);
  // And what it read was written back onto the job before the model ran, so a
  // model failure does not throw the page away.
  assert.match(db.storedText() ?? "", /valkokaalia/);
  assert.equal(db.claimLease(), db.readyLease());
});

test("a linked job that already read its page does not read it again", async () => {
  const db = intakeDatabase({
    source_route: "linked",
    source_text: "Uunikaali\n500 g valkokaalia",
    source_url: "https://kotikokki.example/uunikaali",
  });
  const server = pageServer(RECIPE_PAGE);

  await processIntakeJob(db.env, "owned", {
    fetchPage: server.fetchPage,
    structure: async () => JSON.stringify(SAMPLE_DRAFT),
  });

  // Retrying a model failure must not go back to somebody else's website.
  assert.deepEqual(server.requests(), []);
  assert.equal(db.storedText(), null);
});

const PICTURE = "https://kuvat.example/uunikaali.png";

const ILLUSTRATED_PAGE = `<!doctype html><html><head><title>Uunikaali</title>
  <script type="application/ld+json">${JSON.stringify({
    "@type": "Recipe",
    name: "Uunikaali",
    image: PICTURE,
    recipeYield: "4 annosta",
    recipeIngredient: ["500 g valkokaalia", "1 l vettä"],
    recipeInstructions: "Kuullota kaali pannulla ja paista uunissa tunnin ajan.",
  })}</script></head>
  <body><main><h1>Uunikaali</h1></main></body></html>`;

test("a linked job keeps the picture the page had on it", async () => {
  const db = intakeDatabase({
    source_route: "linked",
    source_text: null,
    source_url: "https://kotikokki.example/uunikaali",
  });
  const bytes = png(900, 600);

  await processIntakeJob(db.env, "owned", {
    fetchPage: siteServer(ILLUSTRATED_PAGE, { [PICTURE]: bytes }),
    structure: async () => JSON.stringify(SAMPLE_DRAFT),
  });

  // The bytes are ours now, in the job's own place in the bucket — not a link
  // back to somebody else's media library.
  assert.equal(db.storedPageImage()?.key, "intake/owned/found.png");
  assert.equal(db.storedPageImage()?.type, "image/png");
  assert.equal(db.storedObjects().get("intake/owned/found.png")?.bytes, bytes.byteLength);

  // And it is still there once the job is ready: unlike a photographed job's
  // input pages, this picture is wanted by the review screen and by the save.
  assert.equal(db.claimLease(), db.readyLease());
  assert.ok(db.storedObjects().has("intake/owned/found.png"));
});

test("a picture that will not download loses only the picture", async () => {
  const db = intakeDatabase({
    source_route: "linked",
    source_text: null,
    source_url: "https://kotikokki.example/uunikaali",
  });

  await processIntakeJob(db.env, "owned", {
    fetchPage: async (url) =>
      url === PICTURE
        ? new Response("", { status: 500 })
        : new Response(ILLUSTRATED_PAGE, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
    structure: async () => JSON.stringify(SAMPLE_DRAFT),
  });

  // The recipe imported. That is the thing the member asked for, and an image
  // server having a bad day must not be able to take it away from them.
  assert.equal(db.claimLease(), db.readyLease());
  assert.equal(db.failedLease(), null);
  assert.match(db.storedText() ?? "", /valkokaalia/);
  assert.equal(db.storedPageImage(), null);
  assert.equal(db.storedObjects().size, 0);
});

test("a page with no picture on it imports exactly as it did before", async () => {
  const db = intakeDatabase({
    source_route: "linked",
    source_text: null,
    source_url: "https://kotikokki.example/uunikaali",
  });
  const server = pageServer(RECIPE_PAGE);

  await processIntakeJob(db.env, "owned", {
    fetchPage: server.fetchPage,
    structure: async () => JSON.stringify(SAMPLE_DRAFT),
  });

  // Nothing was fetched beyond the page itself: no candidate, no request.
  assert.deepEqual(server.requests(), ["https://kotikokki.example/uunikaali"]);
  assert.equal(db.storedPageImage(), null);
  assert.equal(db.claimLease(), db.readyLease());
});

test("a page that gives up no recipe fails the job in Finnish", async () => {
  const db = intakeDatabase({
    source_route: "linked",
    source_text: null,
    source_url: "https://kotikokki.example/etusivu",
  });

  await processIntakeJob(db.env, "owned", {
    fetchPage: async () =>
      new Response("<html><body><p>Ei mitään.</p></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    structure: async () => JSON.stringify(SAMPLE_DRAFT),
  });

  assert.equal(db.claimLease(), db.failedLease());
  assert.equal(
    db.failureMessage(),
    "Sivulta ei löytynyt reseptiä. Voit liittää tekstin itse tuontilomakkeelle.",
  );
});

test("a site that will not answer fails the job in Finnish too", async () => {
  const db = intakeDatabase({
    source_route: "linked",
    source_text: null,
    source_url: "https://kotikokki.example/poissa",
  });

  await processIntakeJob(db.env, "owned", {
    fetchPage: async () => new Response("", { status: 503 }),
    structure: async () => JSON.stringify(SAMPLE_DRAFT),
  });

  assert.equal(
    db.failureMessage(),
    "Sivua ei saatu auki. Tarkista linkki tai kokeile hetken kuluttua uudelleen.",
  );
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

interface FakeMessage {
  body: { jobId: string };
  attempts: number;
  actions: string[];
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

function message(attempts: number): FakeMessage {
  const actions: string[] = [];
  return {
    body: { jobId: `job-${attempts}` },
    attempts,
    actions,
    ack: () => actions.push("ack"),
    retry: (options) => actions.push(`retry:${options?.delaySeconds ?? 0}`),
  };
}

function batch(messages: FakeMessage[]): MessageBatch<{ jobId: string }> {
  return { messages } as unknown as MessageBatch<{ jobId: string }>;
}

function intakeDatabase(overrides: Record<string, unknown> = {}): {
  env: import("../src/env.ts").Env;
  claimLease(): string | null;
  readyLease(): string | null;
  failedLease(): string | null;
  failureMessage(): string | null;
  storedText(): string | null;
  storedPageImage(): { key: string; type: string } | null;
  storedObjects(): Map<string, { bytes: number; contentType: string }>;
} {
  let claimLease: string | null = null;
  let readyLease: string | null = null;
  let failedLease: string | null = null;
  let failureMessage: string | null = null;
  let storedText: string | null = null;
  let storedPageImage: { key: string; type: string } | null = null;
  const storedObjects = new Map<string, { bytes: number; contentType: string }>();
  const row = {
    id: "owned",
    household_id: 1,
    created_by: 1,
    status: "running",
    lease_id: "filled-by-claim",
    source_route: "pasted",
    source_text: SAMPLE_DRAFT.source_text,
    source_url: null,
    import_guidance: null,
    image_refs: null,
    page_image_key: null,
    page_image_type: null,
    draft_json: null,
    error_message: null,
    created_at: "2026-08-28 00:00:00",
    updated_at: "2026-08-28 00:00:00",
    ...overrides,
  };
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind: (...bound: unknown[]) => {
          values = bound;
          return statement;
        },
        run: async () => {
          if (sql.includes("SET status = 'running', lease_id = ?")) {
            claimLease = String(values[0]);
            row.lease_id = claimLease;
          } else if (sql.includes("SET status = 'ready'")) {
            readyLease = String(values[2]);
          } else if (sql.includes("SET status = 'failed'")) {
            failedLease = String(values[2]);
            failureMessage = String(values[0]);
          } else if (sql.includes("SET source_text = ?, source_url = ?")) {
            storedText = String(values[0]);
          } else if (sql.includes("SET page_image_key = ?")) {
            storedPageImage = { key: String(values[0]), type: String(values[1]) };
            row.page_image_key = storedPageImage.key;
            row.page_image_type = storedPageImage.type;
          }
          return { meta: { changes: 1 } };
        },
        first: async () => row,
      };
      return statement;
    },
  };
  return {
    env: {
      DB: db,
      RECIPE_IMAGES: {
        put: async (
          key: string,
          bytes: ArrayBuffer,
          options?: { httpMetadata?: { contentType?: string } },
        ) => {
          storedObjects.set(key, {
            bytes: bytes.byteLength,
            contentType: options?.httpMetadata?.contentType ?? "",
          });
        },
        delete: async (key: string) => {
          storedObjects.delete(key);
        },
      },
      INTAKE_QUEUE: {},
    } as unknown as import("../src/env.ts").Env,
    claimLease: () => claimLease,
    readyLease: () => readyLease,
    failedLease: () => failedLease,
    failureMessage: () => failureMessage,
    storedText: () => storedText,
    storedPageImage: () => storedPageImage,
    storedObjects: () => storedObjects,
  };
}

/**
 * A stand-in site: one page, plus the pictures hanging off it. Fresh responses
 * per call, because a body can only be read once.
 */
function siteServer(
  markup: string,
  images: Record<string, Buffer>,
): import("../src/recipe-fetch.ts").PageFetcher {
  return async (url) => {
    const image = images[url];
    if (image !== undefined) {
      return new Response(image, { headers: { "Content-Type": "image/png" } });
    }
    return new Response(markup, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };
}

/** A stand-in web server: one page of markup, and a count of what was asked. */
function pageServer(markup: string): {
  fetchPage: import("../src/recipe-fetch.ts").PageFetcher;
  requests(): string[];
} {
  const requests: string[] = [];
  return {
    fetchPage: async (url) => {
      requests.push(url);
      return new Response(markup, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
    requests: () => requests,
  };
}
