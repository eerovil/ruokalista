import assert from "node:assert/strict";
import test from "node:test";

import {
  collectValidatedDraft,
  maintainIntakeJobs,
  processIntakeJob,
  processIntakeQueue,
} from "../src/intake-jobs.ts";
import { encodeDraftStreamRecord } from "../src/intake.ts";
import { SAMPLE_DRAFT } from "../src/sample-draft.ts";

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

function intakeDatabase(): {
  env: import("../src/env.ts").Env;
  claimLease(): string | null;
  readyLease(): string | null;
  failedLease(): string | null;
} {
  let claimLease: string | null = null;
  let readyLease: string | null = null;
  let failedLease: string | null = null;
  const row = {
    id: "owned",
    household_id: 1,
    created_by: 1,
    status: "running",
    lease_id: "filled-by-claim",
    source_route: "pasted",
    source_text: SAMPLE_DRAFT.source_text,
    image_refs: null,
    draft_json: null,
    error_message: null,
    created_at: "2026-08-28 00:00:00",
    updated_at: "2026-08-28 00:00:00",
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
      RECIPE_IMAGES: {},
      INTAKE_QUEUE: {},
    } as unknown as import("../src/env.ts").Env,
    claimLease: () => claimLease,
    readyLease: () => readyLease,
    failedLease: () => failedLease,
  };
}
