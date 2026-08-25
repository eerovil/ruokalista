import assert from "node:assert/strict";
import test from "node:test";

import { Router } from "../src/router.ts";

test("a malformed percent escape is a 404 rather than an exception", async () => {
  const router = new Router().get(
    "/recipes/:id",
    () => new Response("matched"),
  );

  const response = await router.handle(
    new Request("https://example.test/recipes/%E0%A4%A"),
    {} as never,
  );

  assert.equal(response.status, 404);
});
