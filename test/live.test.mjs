import assert from "node:assert/strict";
import { test } from "node:test";
import { ask } from "../dist/index.js";

test("one real TypeSafe judgment", { skip: !process.env.TYPESAFE_API_KEY }, async () => {
  const result = await ask({
    state: "A customer requests a refund for a duplicate charge.",
    questions: { refund: { type: "noul", instructions: "Does the customer ask for a refund?" } },
    model: "jev-latest",
    signal: AbortSignal.timeout(30_000),
  }, { env: { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY } });
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  assert.equal(result.answer.refund.type, "noul");
  assert.ok(result.answer.refund.noul >= 0 && result.answer.refund.noul <= 1);
  assert.ok(Number.isSafeInteger(result.usage.input_tokens) && result.usage.input_tokens > 0);
  assert.ok(Number.isSafeInteger(result.usage.output_tokens) && result.usage.output_tokens >= 0);
  assert.ok(result.model.trim());
});
