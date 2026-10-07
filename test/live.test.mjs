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

test("one real OpenAI Decisions judgment of each type", { skip: !(process.env.JEV_OPENAI_API_KEY || process.env.OPENAI_API_KEY) }, async () => {
  const result = await ask({
    state: { ticket: "I was charged twice for my order and want my money back." },
    questions: {
      refund: { type: "noul", instructions: "Does the customer ask for a refund?", criteria: { true: "A refund or reversal is requested", false: "No refund is requested" } },
      team: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments and refunds", technical: "Product bugs", other: null } },
      urgency: { type: "score", instructions: "How urgent is this ticket?", criteria: ["Can wait", "Soon", "Immediately"] },
    },
    model: "jev-latest",
    signal: AbortSignal.timeout(30_000),
  }, { env: { JEV_PROVIDER: "openai", JEV_OPENAI_API_KEY: process.env.JEV_OPENAI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY } });
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  assert.equal(result.provider, "openai");
  assert.ok(result.answer.refund.noul > 0.5, `refund ${result.answer.refund.noul}`);
  assert.equal(result.answer.team.choice, "billing");
  assert.ok(result.answer.urgency.score >= 0 && result.answer.urgency.score <= 2);
  assert.ok(Number.isSafeInteger(result.usage.input_tokens) && result.usage.input_tokens > 0);
  assert.match(result.model, /^gpt-/);
});
