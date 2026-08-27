import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TOKENS,
  RetryableStructuringError,
  structureDraftWith,
  type DraftModelClient,
} from "../src/intake.ts";

/**
 * The plain form post to `POST /intake` — the path a browser without
 * JavaScript takes — used to ask the SDK for a whole message at once. The SDK
 * refuses a non-streaming request whose `max_tokens` implies more than ten
 * minutes of work (roughly 21,300 tokens), so at MAX_TOKENS it threw before
 * anything left the Worker (issue #152).
 *
 * These run the real `structureDraftWith` against a stand-in client, so the
 * whole path is exercised without a paid call: what it asks for, that it asks
 * by streaming, and what it does with the answer.
 */

const DRAFT = {
  title: "Uunikaali",
  yield_portions: 4,
  source_text: "Uunikaali\n1 kaali\n2 dl kermaa",
  steps: [
    {
      text: "Lohko kaali ja levitä vuokaan.",
      section: null,
      phase: null,
      ingredient_refs: [
        { line: 0, matched_text: "kaali", approx_position: 6 },
      ],
    },
  ],
  lines: [
    {
      quantity: 1,
      quantity_max: null,
      unit: null,
      alt_quantity: null,
      alt_unit: null,
      ingredient_id: 7,
      ingredient_name: "kaali",
      source_line: "1 kaali",
      section: null,
      phase: null,
      note: null,
    },
  ],
};

/** A client that answers from a canned message and records what it was asked. */
function standIn(
  message: Partial<{
    content: Array<{ type: string; text?: string }>;
    stop_reason: string | null;
    usage: unknown;
    model: string;
  }> = {},
) {
  const asked: { streamed: unknown[]; created: unknown[] } = {
    streamed: [],
    created: [],
  };

  const client = {
    messages: {
      // Present so a return to the non-streaming call is a failed assertion
      // here rather than a Finnish-language screen showing an English SDK
      // sentence in production.
      create(body: unknown) {
        asked.created.push(body);
        throw new Error("messages.create must not be used: see issue #152");
      },
      stream(body: unknown) {
        asked.streamed.push(body);
        return {
          finalMessage: async () => ({
            content: [{ type: "text", text: JSON.stringify(DRAFT) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
            model: "claude-sonnet-5",
            ...message,
          }),
        };
      },
    },
  };

  return { client: client as unknown as DraftModelClient, asked };
}

const PASTED = { route: "pasted" as const, text: "Uunikaali\n1 kaali" };

test("a pasted import streams the model call rather than asking for a whole message", async () => {
  const { client, asked } = standIn();

  await structureDraftWith(client, PASTED, [{ id: 7, name: "kaali" }]);

  assert.equal(asked.created.length, 0);
  assert.equal(asked.streamed.length, 1);
});

test("the streamed request carries the shared output token ceiling", async () => {
  const { client, asked } = standIn();

  await structureDraftWith(client, PASTED, [{ id: 7, name: "kaali" }]);

  const body = asked.streamed[0] as { max_tokens: number; model: string };
  assert.equal(body.max_tokens, MAX_TOKENS);
  assert.equal(body.model, "claude-sonnet-5");
});

test("the output token ceiling is above what a non-streaming call may ask for", () => {
  // The SDK's own arithmetic: it refuses when 60 minutes scaled by
  // max_tokens/128000 exceeds 10 minutes. This is why streaming is not
  // optional here, and it fails if somebody lowers MAX_TOKENS back under the
  // ceiling and concludes the streaming is now pointless.
  const nonStreamingCeiling = (10 / 60) * 128000;
  assert.ok(MAX_TOKENS > nonStreamingCeiling);
});

test("the collected stream is parsed into a draft", async () => {
  const { client } = standIn();

  const draft = await structureDraftWith(client, PASTED, [
    { id: 7, name: "kaali" },
  ]);

  assert.equal(draft.title, "Uunikaali");
  assert.equal(draft.yieldPortions, 4);
  assert.equal(draft.lines.length, 1);
  assert.equal(draft.lines[0]?.ingredientId, 7);
  assert.equal(draft.steps.length, 1);
  assert.equal(draft.steps[0]?.refs.length, 1);
  // A paste keeps exactly what arrived, not the model's echo of it.
  assert.equal(draft.sourceText, PASTED.text);
  assert.equal(draft.structuredBy, "claude-sonnet-5");
});

test("a draft cut off at the ceiling is retryable rather than shown", async () => {
  const { client } = standIn({ stop_reason: "max_tokens" });

  await assert.rejects(
    structureDraftWith(client, PASTED, []),
    RetryableStructuringError,
  );
});

test("a failed model call is retryable", async () => {
  const client = {
    messages: {
      stream() {
        return {
          finalMessage: async () => {
            throw new Error("Streaming is required for operations that may take longer than 10 minutes.");
          },
        };
      },
    },
  } as unknown as DraftModelClient;

  await assert.rejects(
    structureDraftWith(client, PASTED, []),
    RetryableStructuringError,
  );
});
