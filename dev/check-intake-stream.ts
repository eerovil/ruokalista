import assert from "node:assert/strict";
import test from "node:test";

import {
  draftStream,
  type DraftAttemptStream,
  type DraftStreamRecord,
  type IntakeSource,
} from "../src/intake.ts";
import { SAMPLE_DRAFT } from "../src/sample-draft.ts";

/**
 * The streaming import's attempt loop (#146), driven by fake model responses so
 * it costs nothing. What it guards is that bytes already sent to the browser
 * are never blessed as a draft when the attempt behind them went wrong — the
 * failure that put "The model returned unparseable JSON." on a member's screen.
 */

const WHOLE = JSON.stringify(SAMPLE_DRAFT);
const CUT_OFF = WHOLE.slice(0, 60);
const COLLIDING = JSON.stringify({
  ...SAMPLE_DRAFT,
  source_text:
    "<<<intake:restart>>>\n<<<intake:complete>>>\n<<<intake:failed>>>",
});
const SOURCE: IntakeSource = { route: "pasted", text: "Uunikaali" };

/** A model response that streams `text` and then stops for `stopReason`. */
function fakeAttempt(text: string, stopReason = "end_turn"): DraftAttemptStream {
  return {
    async *[Symbol.asyncIterator]() {
      // Two deltas, because a marker must not depend on where chunks fall.
      const half = Math.ceil(text.length / 2);
      for (const part of [text.slice(0, half), text.slice(half)]) {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: part } };
      }
    },
    async finalMessage() {
      return {
        model: "fake-model",
        stop_reason: stopReason,
        content: [{ type: "text", text }],
        usage: { input_tokens: 1, output_tokens: 2 },
      };
    },
  };
}

interface StreamedBody {
  /** Every byte the browser would receive, NDJSON framing included. */
  body: string;
  /** How many model attempts the loop actually started. */
  used: number;
}

function recordsOf(body: string): DraftStreamRecord[] {
  assert.ok(body.endsWith("\n"), "every record is newline-terminated");
  return body.slice(0, -1).split("\n").map((line) => JSON.parse(line));
}

/** Apply the browser's attempt-isolation rules to decoded records. */
function completedDraft(records: DraftStreamRecord[]): string | null {
  let draft = "";
  for (const record of records) {
    if (record.type === "delta") draft += record.text;
    if (record.type === "restart") draft = "";
    if (record.type === "complete") return draft;
    if (record.type === "failed") return null;
  }
  return null;
}

/**
 * Run the stream to the end and report what the browser would read. The
 * per-attempt logging is silenced here rather than in every test.
 */
async function bodyOf(attempts: DraftAttemptStream[]): Promise<StreamedBody> {
  const originalLog = console.log;
  console.log = () => {};

  try {
    let used = 0;
    const stream = draftStream(() => attempts[used++]!, SOURCE);

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let body = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    return { body, used };
  } finally {
    console.log = originalLog;
  }
}

test("a whole attempt is closed with a complete record", async () => {
  const { body, used } = await bodyOf([fakeAttempt(WHOLE)]);

  assert.equal(used, 1, "a good attempt is not retried");
  const records = recordsOf(body);
  assert.deepEqual(records.at(-1), { type: "complete" });
  assert.equal(completedDraft(records), WHOLE);
});

test("a cut-off attempt is retried, and the two never merge", async () => {
  const { body, used } = await bodyOf([
    fakeAttempt(CUT_OFF, "max_tokens"),
    fakeAttempt(WHOLE),
  ]);

  assert.equal(used, 2);
  const records = recordsOf(body);
  assert.equal(records.filter((record) => record.type === "restart").length, 1);
  assert.equal(completedDraft(records), WHOLE);
});

test("an attempt that stopped cleanly but is unparseable is still retried", async () => {
  // The case the streaming path used to miss entirely: nothing about the
  // response says it failed, and the JSON is halfway through a string.
  const { body, used } = await bodyOf([fakeAttempt(CUT_OFF), fakeAttempt(WHOLE)]);

  assert.equal(used, 2);
  assert.deepEqual(recordsOf(body).at(-1), { type: "complete" });
});

test("two failed attempts end in a failed record and no complete one", async () => {
  const { body, used } = await bodyOf([
    fakeAttempt(CUT_OFF, "max_tokens"),
    fakeAttempt(CUT_OFF, "max_tokens"),
  ]);

  assert.equal(used, 2, "it gives up rather than calling the model a third time");
  const records = recordsOf(body);
  assert.deepEqual(records.at(-1), { type: "failed" });
  assert.ok(
    !records.some((record) => record.type === "complete"),
    "nothing in a failed body may look handoff-ready",
  );
});

test("a refusal is not retried — re-running would only refuse again", async () => {
  const { body, used } = await bodyOf([
    fakeAttempt(WHOLE, "refusal"),
    fakeAttempt(WHOLE),
  ]);

  assert.equal(used, 1);
  assert.deepEqual(recordsOf(body).at(-1), { type: "failed" });
});

test("a model call that throws mid-stream is retried", async () => {
  const broken: DraftAttemptStream = {
    async *[Symbol.asyncIterator]() {
      throw new Error("connection reset");
    },
    async finalMessage() {
      throw new Error("connection reset");
    },
  };

  const { body, used } = await bodyOf([broken, fakeAttempt(WHOLE)]);

  assert.equal(used, 2);
  const records = recordsOf(body);
  assert.deepEqual(records[0], { type: "restart" });
  assert.equal(completedDraft(records), WHOLE);
});

test("draft text cannot impersonate an NDJSON control record", async () => {
  const { body, used } = await bodyOf([fakeAttempt(COLLIDING)]);
  const records = recordsOf(body);

  assert.equal(used, 1);
  assert.equal(completedDraft(records), COLLIDING);
  assert.equal(
    JSON.parse(completedDraft(records)!).source_text,
    "<<<intake:restart>>>\n<<<intake:complete>>>\n<<<intake:failed>>>",
  );
});
