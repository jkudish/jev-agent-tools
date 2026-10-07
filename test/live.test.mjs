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

test("one real OpenAI Decisions judgment of each type", { skip: !(process.env.DISCERN_OPENAI_API_KEY || process.env.JEV_OPENAI_API_KEY || process.env.OPENAI_API_KEY) }, async () => {
  const result = await ask({
    state: { ticket: "I was charged twice for my order and want my money back." },
    questions: {
      refund: { type: "noul", instructions: "Does the customer ask for a refund?", criteria: { true: "A refund or reversal is requested", false: "No refund is requested" } },
      team: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments and refunds", technical: "Product bugs", other: null } },
      urgency: { type: "score", instructions: "How urgent is this ticket?", criteria: ["Can wait", "Soon", "Immediately"] },
    },
    model: "jev-latest",
    signal: AbortSignal.timeout(30_000),
  }, { env: { DISCERN_PROVIDER: "openai", DISCERN_OPENAI_API_KEY: process.env.DISCERN_OPENAI_API_KEY || process.env.JEV_OPENAI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY } });
  assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  assert.equal(result.provider, "openai");
  assert.ok(result.answer.refund.noul > 0.5, `refund ${result.answer.refund.noul}`);
  assert.equal(result.answer.team.choice, "billing");
  assert.ok(result.answer.urgency.score >= 0 && result.answer.urgency.score <= 2);
  assert.ok(Number.isSafeInteger(result.usage.input_tokens) && result.usage.input_tokens > 0);
  assert.match(result.model, /^gpt-/);
});

const cfToken = process.env.DISCERN_CLOUDFLARE_API_TOKEN || process.env.JEV_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
for (const model of ["clef", "clef-flash"]) {
  test(`one real Cloudflare ${model} judgment of each type`, { skip: !(cfToken && process.env.CLOUDFLARE_ACCOUNT_ID) }, async () => {
    const result = await ask({
      state: { ticket: "I was charged twice for my order and want my money back." },
      questions: {
        refund: { type: "noul", instructions: "Does the customer ask for a refund?" },
        team: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: "Payments and refunds", technical: "Product bugs", other: null } },
        urgency: { type: "score", instructions: "How urgent is this ticket?", criteria: ["Can wait", "Soon", "Immediately"] },
      },
      model,
      signal: AbortSignal.timeout(30_000),
    }, { env: { DISCERN_PROVIDER: "cloudflare", DISCERN_CLOUDFLARE_API_TOKEN: cfToken, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID } });
    assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
    assert.equal(result.provider, "cloudflare");
    assert.equal(result.model, model);
    assert.ok(result.answer.refund.noul > 0.5, `refund ${result.answer.refund.noul}`);
    assert.equal(result.answer.team.choice, "billing");
    assert.ok(result.answer.urgency.score >= 0 && result.answer.urgency.score <= 2);
  });
}
