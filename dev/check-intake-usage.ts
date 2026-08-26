import assert from "node:assert/strict";
import test from "node:test";

import { logImportUsage } from "../src/intake.ts";

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
