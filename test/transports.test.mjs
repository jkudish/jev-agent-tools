import assert from "node:assert/strict";
import { test } from "node:test";
import { ask, resolveTransport } from "../dist/index.js";
import { typesafe } from "../dist/transports/typesafe.js";
import { openrouter } from "../dist/transports/openrouter.js";
import { cloudflare } from "../dist/transports/cloudflare.js";
import { createVercelDriver, adaptVercelAnswers } from "../dist/transports/vercel.js";

const askJev = (transport, input) => ask(input, { transport });
const rejected = (result, code, pattern) => {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.match(result.message, pattern);
  assert.doesNotMatch(result.message, /body-secret|ts-secret|sk-or-secret|high-secret|low-secret|ai-secret/);
};

const signal = new AbortController().signal;
const questions = { item: { type: "choice", criteria: { alpha: "A", beta: "B" } }, yes: { type: "noul" } };
const answers = { item: { type: "choice", choice: "beta", probabilities: { alpha: 0.2, beta: 0.8 } }, yes: { type: "noul", noul: 0.7 } };
const input = { state: { title: "Example" }, questions, model: "jev-latest", signal };
const usage = { input_tokens: 13, output_tokens: 3 };
const carrier = (override = {}) => ({ name: "fixture", ask: async () => ({ answers, usage, model: "effective", ...override }) });

async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("registry auto-detects in precedence order and explicit names select only themselves", () => {
  const all = { TYPESAFE_API_KEY: "ts-secret", OPENROUTER_API_KEY: "sk-or-secret", CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "account", AI_GATEWAY_API_KEY: "ai-secret" };
  for (const [removed, expected] of [
    [[], "typesafe"],
    [["TYPESAFE_API_KEY"], "openrouter"],
    [["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"], "cloudflare"],
    [["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN"], "vercel"],
  ]) {
    const env = { ...all };
    for (const key of removed) delete env[key];
    assert.equal(resolveTransport(env).name, expected);
  }
  for (const name of ["typesafe", "openrouter", "cloudflare", "vercel"]) {
    assert.equal(resolveTransport({ ...all, JEV_PROVIDER: name.toUpperCase() }).name, name);
  }
  assert.equal(resolveTransport({ JEV_CLOUDFLARE_API_TOKEN: "pref", CLOUDFLARE_ACCOUNT_ID: "account" }).name, "cloudflare");
  assert.throws(() => resolveTransport({ ...all, JEV_PROVIDER: "typo" }), /Unknown JEV_PROVIDER/);
  assert.throws(() => resolveTransport({}), (error) => ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "JEV_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_API_KEY"].every((name) => error.message.includes(name)));
});

test("public ask returns configuration errors and redacts thrown transport details", async () => {
  rejected(await ask(input, { env: { JEV_PROVIDER: "typo" } }), "configuration_error", /Unknown JEV_PROVIDER/);
  const absent = await ask(input, { env: {} });
  rejected(absent, "configuration_error", /No TYPESAFE_API_KEY/);
  for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "JEV_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_API_KEY"]) {
    assert.ok(absent.message.includes(name));
  }
  rejected(await ask(input, { transport: { name: "body-secret", ask: async () => { throw Error("body-secret ts-secret"); } } }), "request_failed", /provider unknown: request failed/);
});

test("forced credentials reject every missing or invalid variant without leaking values", () => {
  const cases = [
    ["typesafe", {}, /TYPESAFE_API_KEY/],
    ["openrouter", {}, /OPENROUTER_API_KEY/],
    ["openrouter", { OPENROUTER_API_KEY: "wrong-secret" }, /sk-or-/],
    ["cloudflare", {}, /CLOUDFLARE_ACCOUNT_ID/],
    ["cloudflare", { CLOUDFLARE_API_TOKEN: "cf-secret" }, /CLOUDFLARE_ACCOUNT_ID/],
    ["cloudflare", { CLOUDFLARE_ACCOUNT_ID: "account-secret" }, /CLOUDFLARE_API_TOKEN/],
    ["cloudflare", { JEV_CLOUDFLARE_API_TOKEN: "cf-secret" }, /CLOUDFLARE_ACCOUNT_ID/],
    ["vercel", {}, /AI_GATEWAY_API_KEY/],
  ];
  for (const [name, env, pattern] of cases) {
    assert.throws(() => resolveTransport({ ...env, JEV_PROVIDER: name }), (error) => {
      assert.match(error.message, pattern);
      assert.ok(error.message.startsWith(`JEV_PROVIDER=${name}`));
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  assert.equal(resolveTransport({ OPENROUTER_API_KEY: "wrong-secret", AI_GATEWAY_API_KEY: "ai-secret" }).name, "vercel");
  assert.equal(resolveTransport({ CLOUDFLARE_ACCOUNT_ID: "account-secret", AI_GATEWAY_API_KEY: "ai-secret" }).name, "vercel");
});

test("sum tolerance scales with two-decimal rounding across live options, but stays bounded", async () => {
  // A wide action space (like a search results page): 60 options, most at 0.
  const criteria = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`o${i}`, `option ${i}`]));
  const wide = { ...input, questions: { pick: { type: "choice", criteria } } };
  const reply = (weights) => {
    const probabilities = Object.fromEntries(Object.keys(criteria).map((key, i) => [key, weights[i] ?? 0]));
    return carrier({ answers: { pick: { type: "choice", choice: "o0", probabilities } } });
  };
  // 8 live options rounded to two decimals, summing to 0.98 (seen live) and 1.02: accepted.
  assert.equal((await askJev(reply([0.4, 0.2, 0.14, 0.1, 0.06, 0.04, 0.02, 0.02]), wide)).ok, true);
  assert.equal((await askJev(reply([0.44, 0.15, 0.15, 0.1, 0.08, 0.05, 0.03, 0.02]), wide)).ok, true);
  // Two live options can only drift 0.01: 0.97 is not rounding.
  rejected(await askJev(reply([0.6, 0.37]), wide), "invalid_distribution", /approximately 1/);
  // An exact 1.01 on two options is valid rounding, despite 1.01 - 1 > 0.01 in IEEE-754.
  assert.equal((await askJev(carrier({ answers: { ...answers, item: { ...answers.item, probabilities: { alpha: 0.2, beta: 0.81 } } } }), input)).ok, true);
  // The drift is capped at five percent no matter how many options are live.
  rejected(await askJev(reply(Array.from({ length: 20 }, (_, i) => (i === 0 ? 0.13 : 0.05))), wide), "invalid_distribution", /approximately 1/);
});

test("facade validates the complete answer contract before usage can be credited", async () => {
  const good = await askJev(carrier(), input);
  assert.equal(good.ok, true);
  assert.equal(good.provider, "fixture");
  assert.equal(good.answer.item.confidence, null);
  assert.equal(good.model, "effective");
  for (const [mutated, id, code, reason] of [
    [{ item: answers.item }, "yes", "answer_id_mismatch", /missing answer/],
    [{ ...answers, item: { ...answers.item, type: "noul" } }, "item", "malformed_answer", /wrong type/],
    [{ ...answers, item: { ...answers.item, choice: "gamma" } }, "item", "invalid_choice", /outside criteria/],
    [{ ...answers, item: { ...answers.item, choice: "alpha" } }, "item", "invalid_choice", /not a distribution maximum/],
    [{ ...answers, item: { ...answers.item, probabilities: { alpha: NaN, beta: 0.8 } } }, "item", "invalid_distribution", /finite probabilities/],
    [{ ...answers, item: { ...answers.item, probabilities: { alpha: 0.1, beta: 0.7 } } }, "item", "invalid_distribution", /approximately 1/],
    [{ ...answers, item: { ...answers.item, probabilities: { alpha: 0.2, beta: 0.7, extra: 0.1 } } }, "item", "invalid_distribution", /exactly the criteria/],
    [{ ...answers, item: { ...answers.item, confidence: Infinity } }, "item", "invalid_confidence", /confidence/],
    [{ ...answers, yes: { type: "noul", noul: 1.1 } }, "yes", "invalid_noul", /noul/],
  ]) {
    rejected(await askJev(carrier({ answers: mutated }), input), code, new RegExp(`provider fixture question ${id}.*${reason.source}`));
  }
  rejected(await askJev(carrier({ usage: { input_tokens: -1, output_tokens: 0 } }), input), "invalid_usage", /question <response>.*usage/);
  rejected(await askJev(carrier({ usage: { input_tokens: undefined, output_tokens: 0 } }), input), "invalid_usage", /question <response>.*usage/);
  rejected(await askJev(carrier({ model: " " }), input), "invalid_model", /question <response>.*model/);
  rejected(await askJev(carrier({ answers: { ...answers, extra: answers.yes } }), input), "answer_id_mismatch", /unexpected answer ID/);
  rejected(await askJev(carrier({ usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 } }), input), "invalid_usage", /safe integers/);
  rejected(await askJev(carrier({ answers: { ...answers, yes: { type: "noul", noul: -0.1 } } }), input), "invalid_noul", /noul/);
  const boundary = { ...answers, item: { ...answers.item, probabilities: { alpha: 0.2, beta: 0.809 } } };
  assert.equal((await askJev(carrier({ answers: boundary }), input)).ok, true);
  rejected(await askJev(carrier({ answers: { ...answers, item: { ...boundary.item, probabilities: { alpha: 0.2, beta: 0.811 } } } }), input), "invalid_distribution", /approximately 1/);
  const tied = { ...answers, item: { ...answers.item, choice: "alpha", probabilities: { alpha: 0.4995, beta: 0.5005 }, confidence: 0 } };
  assert.equal((await askJev(carrier({ answers: tied }), input)).answer.item.choice, "alpha");
  const score = { state: null, model: "jev", signal, questions: { rank: { type: "score", criteria: ["poor", "good", "great"] } } };
  const scoreReply = { rank: { type: "score", score: 2, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, confidence: null } };
  assert.equal((await askJev(carrier({ answers: scoreReply }), score)).answer.rank.score, 2);
  rejected(await askJev(carrier({ answers: { rank: { ...scoreReply.rank, score: 3 } } }), score), "invalid_choice", /question rank.*score is outside/);
});

test("reserved object keys remain owned criteria and answer IDs", async () => {
  const criteria = JSON.parse('{"__proto__":"First","other":"Second"}');
  const special = { ...input, questions: { item: { type: "choice", criteria } } };
  const makeReply = (first, second, choice) => ({ item: { type: "choice", choice, probabilities: JSON.parse(`{"__proto__":${first},"other":${second}}`) } });
  rejected(await askJev(carrier({ answers: makeReply(0.1, 0.9, "__proto__") }), special), "invalid_choice", /not a distribution maximum/);
  const winner = await askJev(carrier({ answers: makeReply(0.9, 0.1, "__proto__") }), special);
  assert.equal(winner.ok, true);
  assert.ok(Object.hasOwn(winner.answer.item.probabilities, "__proto__"));
  assert.equal(winner.answer.item.probabilities.__proto__, 0.9);

  const namedQuestion = { ...input, questions: JSON.parse('{"__proto__":{"type":"noul"}}') };
  const namedReply = JSON.parse('{"__proto__":{"type":"noul","noul":0.7}}');
  const direct = await askJev(carrier({ answers: namedReply }), namedQuestion);
  assert.equal(direct.ok, true);
  assert.ok(Object.hasOwn(direct.answer, "__proto__"));
  assert.equal(JSON.parse(JSON.stringify(direct.answer)).__proto__.noul, 0.7);

  let submitted;
  await withFetch(async (_url, init) => {
    submitted = JSON.parse(init.body);
    return Response.json({ answers: JSON.parse('{"__proto__":{"type":"boolean","probability":0.7}}'), usage: { inputTokens: 13, outputTokens: 3 } });
  }, async () => {
    const result = await ask(namedQuestion, { env: { AI_GATEWAY_API_KEY: "ai-secret" } });
    assert.equal(result.ok, true);
    assert.ok(Object.hasOwn(result.answer, "__proto__"));
  });
  assert.ok(Object.hasOwn(submitted.questions, "__proto__"));

  for (const [type, criterion, reply] of [
    ["choice", { alpha: "A", beta: "B" }, { type: "choice", choice: "beta", probabilities: { alpha: 0.2, beta: 0.8 } }],
    ["score", ["low", "high"], { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8 } }],
  ]) {
    const named = { ...input, questions: Object.fromEntries([["__proto__", { type, criteria: criterion }]]) };
    const wire = { answers: Object.fromEntries([["__proto__", reply]]), usage: { inputTokens: 13, outputTokens: 3 } };
    for (const metadata of [undefined, { typesafe: { confidence: {} } }]) {
      const result = await askJev(createVercelDriver(async () => ({ ...wire, providerMetadata: metadata })).create({ AI_GATEWAY_API_KEY: "ai-secret" }), named);
      assert.equal(result.ok, true);
      assert.ok(Object.hasOwn(result.answer, "__proto__"));
      assert.equal(result.answer.__proto__.confidence, null);
    }
    const owned = await askJev(createVercelDriver(async () => ({ ...wire, providerMetadata: { typesafe: { confidence: Object.fromEntries([["__proto__", 0.74]]) } } })).create({ AI_GATEWAY_API_KEY: "ai-secret" }), named);
    assert.equal(owned.ok, true);
    assert.equal(owned.answer.__proto__.confidence, 0.74);
  }
});

test("TypeSafe client binds key and base URL at creation, forwards request and cancellation", async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ answers, usage });
  }, async () => {
    const transport = typesafe.create({ TYPESAFE_API_KEY: "ts-secret", TYPESAFE_BASE_URL: "https://local.typesafe.test" });
    const reply = await askJev(transport, input);
    assert.deepEqual(reply.usage, usage);
    assert.equal(reply.model, "jev-latest");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://local.typesafe.test/v1/systemone");
    assert.equal(calls[0].init.headers.Authorization, "Bearer ts-secret");
    assert.deepEqual(JSON.parse(calls[0].init.body), { state: input.state, questions, model: "jev-latest" });
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.equal(calls[0].init.signal.aborted, false);
  });
  await withFetch(async () => Response.json({ error: "body-secret" }, { status: 400 }), async () => {
    rejected(await askJev(typesafe.create({ TYPESAFE_API_KEY: "ts-secret" }), input), "request_failed", /request failed/);
  });
});

test("OpenRouter maps latest and pinned slugs, sends exact envelope and redacts HTTP errors", async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ answers, usage });
  }, async () => {
    const transport = openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" });
    assert.equal((await askJev(transport, input)).model, "typesafe/jev-1.13");
    assert.equal((await askJev(transport, { ...input, model: "typesafe/jev-1.12" })).model, "typesafe/jev-1.12");
    assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer sk-or-secret", "Content-Type": "application/json", "HTTP-Referer": "https://github.com/jkudish/jev-browser", "X-Title": "jev-browser", "X-OpenRouter-Title": "jev-browser" });
    assert.equal(calls[0].init.signal, signal);
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "typesafe/jev-1.13", state: input.state, questions });
  });
  for (const response of [new Response("body-secret", { status: 403 }), new Response("body-secret", { status: 200 })]) {
    await withFetch(async () => response, async () => {
      rejected(await askJev(openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }), input), "request_failed", /request failed/);
    });
  }
  await withFetch(async () => Response.json({ usage }), async () => {
    rejected(await askJev(openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }), input), "malformed_answer", /question <response>.*answers/);
  });
  await withFetch(async () => { throw new Error("body-secret sk-or-secret"); }, async () => {
    rejected(await askJev(openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }), input), "request_failed", /request failed/);
  });
});

test("Cloudflare token priority, double envelope, state, usage, and safe errors", async () => {
  const calls = [];
  const env = { CLOUDFLARE_API_TOKEN: "low-secret", JEV_CLOUDFLARE_API_TOKEN: "high-secret", CLOUDFLARE_ACCOUNT_ID: "account" };
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ success: true, result: { state: "Completed", result: { answers, usage, model: "typesafe/jev" } } });
  }, async () => {
    const transport = cloudflare.create(env);
    assert.deepEqual((await askJev(transport, input)).usage, usage);
    assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/account/ai/run");
    assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer high-secret", "Content-Type": "application/json" });
    assert.equal(calls[0].init.signal, signal);
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "typesafe/jev", input: { state: input.state, questions } });
    assert.equal((await transport.ask({ ...input, model: "typesafe/jev-1.2" })).model, "typesafe/jev");
    assert.equal(JSON.parse(calls[1].init.body).model, "typesafe/jev-1.2");
  });
  for (const response of [new Response("body-secret", { status: 401 }), Response.json({ success: false, errors: ["body-secret"] }), Response.json({ result: { state: "Failed body-secret" } }), new Response("body-secret", { status: 200 })]) {
    await withFetch(async () => response, async () => {
      rejected(await askJev(cloudflare.create(env), input), "request_failed", /request failed/);
    });
  }
  await withFetch(async () => { throw new Error("body-secret high-secret"); }, async () => {
    rejected(await askJev(cloudflare.create(env), input), "request_failed", /request failed/);
  });
});

test("Vercel factory forwards evaluate request and pure adaptation preserves confidence", async () => {
  let call;
  const raw = { item: { type: "choice", choice: "beta", probabilities: { alpha: 0.2, beta: 0.8 } }, yes: { type: "boolean", probability: 0.7 } };
  const result = { answers: raw, usage: { inputTokens: 13, outputTokens: 3 }, providerMetadata: { typesafe: { confidence: { item: 0.92 } } } };
  const factory = createVercelDriver(async (args) => { call = args; return result; });
  const reply = await askJev(factory.create({ AI_GATEWAY_API_KEY: "ai-secret" }), input);
  assert.equal(reply.model, "typesafe-ai/jev");
  assert.deepEqual(reply.usage, usage);
  assert.equal(call.signal, signal);
  assert.equal(call.model, "typesafe-ai/jev");
  assert.deepEqual(call.questions, { item: { type: "choice", instructions: undefined, criteria: questions.item.criteria }, yes: { type: "boolean", instructions: undefined, criteria: undefined } });
  assert.deepEqual(reply.answer, { item: { ...answers.item, confidence: 0.92 }, yes: answers.yes });
  assert.deepEqual(adaptVercelAnswers({ yes: raw.yes, rank: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8 } } }, {}), { yes: answers.yes, rank: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8 }, confidence: null } });
  const failing = createVercelDriver(async () => { throw Object.assign(new Error("body-secret"), { statusCode: 403 }); });
  rejected(await askJev(failing.create({ AI_GATEWAY_API_KEY: "ai-secret" }), input), "request_failed", /request failed/);
  const malformed = createVercelDriver(async () => ({ ...result, answers: { item: raw.item } }));
  rejected(await askJev(malformed.create({ AI_GATEWAY_API_KEY: "ai-secret" }), input), "answer_id_mismatch", /provider vercel question yes.*missing answer/);
});

test("Vercel default fetch sends the evaluation protocol and never echoes HTTP bodies", async () => {
  let request;
  await withFetch(async (url, init) => {
    request = { url, init };
    return Response.json({ answers: { item: answers.item, yes: { type: "boolean", probability: 0.7 } }, usage: { inputTokens: 13, outputTokens: 3 } });
  }, async () => {
    const result = await ask(input, { env: { AI_GATEWAY_API_KEY: "ai-secret" } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.usage, usage);
    assert.deepEqual(result.answer.yes, answers.yes);
  });
  assert.equal(request.url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  assert.equal(request.init.headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(request.init.headers["ai-evaluation-model-specification-version"], "4");
  assert.equal(request.init.headers.Authorization, "Bearer ai-secret");
  assert.equal(request.init.signal, signal);
  assert.deepEqual(JSON.parse(request.init.body), { state: input.state, questions: { item: { type: "choice", criteria: questions.item.criteria }, yes: { type: "boolean" } } });
  await withFetch(async () => Response.json({ error: "body-secret" }, { status: 401 }), async () => {
    rejected(await ask(input, { env: { AI_GATEWAY_API_KEY: "ai-secret" } }), "request_failed", /request failed/);
  });
});

test("all adapters distinguish absent usage from malformed containers and present null counters", async () => {
  const vercelAnswers = { item: answers.item, yes: { type: "boolean", probability: answers.yes.noul } };
  for (const [name, field, run] of [
    ["typesafe", "input_tokens", (wire) => withFetch(async () => Response.json({ answers, ...wire }), () => askJev(typesafe.create({ TYPESAFE_API_KEY: "ts-secret" }), input))],
    ["openrouter", "input_tokens", (wire) => withFetch(async () => Response.json({ answers, ...wire }), () => askJev(openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }), input))],
    ["cloudflare", "input_tokens", (wire) => withFetch(async () => Response.json({ result: { state: "Completed", result: { answers, ...wire } } }), () => askJev(cloudflare.create({ CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "account" }), input))],
    ["vercel", "inputTokens", (wire) => askJev(createVercelDriver(async () => ({ answers: vercelAnswers, ...wire })).create({ AI_GATEWAY_API_KEY: "ai-secret" }), input)],
  ]) {
    assert.deepEqual((await run({})).usage, { input_tokens: 0, output_tokens: 0 }, name);
    assert.deepEqual((await run({ usage: {} })).usage, { input_tokens: 0, output_tokens: 0 }, name);
    const invalidCases = [{ usage: "body-secret" }, { usage: null }, { usage: { [field]: null } }];
    if (name === "vercel") invalidCases.push({ usage: { [field]: undefined } }); // JSON drops undefined properties on the HTTP drivers.
    for (const invalid of invalidCases) {
      const result = await run(invalid);
      rejected(result, invalid.usage === "body-secret" || invalid.usage === null ? "request_failed" : "invalid_usage", /usage|request failed/);
    }
  }
});
