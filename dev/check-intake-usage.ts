import assert from "node:assert/strict";
import test from "node:test";

import type { Env } from "../src/env.ts";
import { logImportUsage, streamDraft } from "../src/intake.ts";

test("import usage log keeps the recipe title and complete provider usage", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));

  try {
    logImportUsage("Uunikaali", {
      input_tokens: 123,
      output_tokens: 456,
      cache_read_input_tokens: 78,
      server_tool_use: { web_search_requests: 0 },
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(logs[0]!), {
    event: "intake.model_usage",
    recipe_title: "Uunikaali",
    usage: {
      input_tokens: 123,
      output_tokens: 456,
      cache_read_input_tokens: 78,
      server_tool_use: { web_search_requests: 0 },
    },
  });
});

test("a terminal stream failure is logged, and the body ends in a failed record", async () => {
  const logs: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = async () => new Response(
    JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "test refusal" },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));

  try {
    const reader = streamDraft(
      { ANTHROPIC_API_KEY: "test-key" } as Env,
      { route: "pasted", text: "Uunikaali" },
      [],
    ).getReader();

    // The stream is not torn down (#146): a body that just stops is
    // indistinguishable from a dropped connection, so the browser is told in
    // band instead. The last record must be `failed` and never `complete`.
    const decoder = new TextDecoder();
    let body = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    assert.equal(body.endsWith('{"type":"failed"}\n'), true);
    assert.equal(body.includes('{"type":"complete"}'), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }

  const failure = logs.map((line) => JSON.parse(line)).find(
    (entry) => entry.event === "intake.failed",
  );
  assert.equal(failure.detail.includes("test refusal"), true);
});
