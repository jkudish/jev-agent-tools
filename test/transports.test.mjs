import assert from "node:assert/strict";
import { test } from "node:test";
import { ask, cloudflareModel, normalizeDiscernEnv, openaiDecisionsModel, openrouterJevModel, resolveTransport } from "../dist/index.js";
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
    assert.equal(resolveTransport({ ...all, DISCERN_PROVIDER: name.toUpperCase() }).name, name);
  }
  assert.equal(resolveTransport({ DISCERN_CLOUDFLARE_API_TOKEN: "pref", CLOUDFLARE_ACCOUNT_ID: "account" }).name, "cloudflare");
  assert.throws(() => resolveTransport({ ...all, DISCERN_PROVIDER: "typo" }), /Unknown DISCERN_PROVIDER/);
  assert.throws(() => resolveTransport({}), (error) => ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "DISCERN_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_API_KEY"].every((name) => error.message.includes(name)));
});

test("public ask returns configuration errors and redacts thrown transport details", async () => {
  rejected(await ask(input, { env: { DISCERN_PROVIDER: "typo" } }), "configuration_error", /Unknown DISCERN_PROVIDER/);
  const absent = await ask(input, { env: {} });
  rejected(absent, "configuration_error", /No TYPESAFE_API_KEY/);
  for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "DISCERN_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_API_KEY"]) {
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
    ["cloudflare", { DISCERN_CLOUDFLARE_API_TOKEN: "cf-secret" }, /CLOUDFLARE_ACCOUNT_ID/],
    ["vercel", {}, /AI_GATEWAY_API_KEY/],
  ];
  for (const [name, env, pattern] of cases) {
    assert.throws(() => resolveTransport({ ...env, DISCERN_PROVIDER: name }), (error) => {
      assert.match(error.message, pattern);
      assert.ok(error.message.startsWith(`DISCERN_PROVIDER=${name}`));
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
  for (const [requested, expected] of [
    ["jev-latest", "~typesafe/jev-latest"],
    ["typesafe/jev-latest", "~typesafe/jev-latest"],
    ["~typesafe/jev-latest", "~typesafe/jev-latest"],
    ["jev-1.13", "typesafe/jev-1.13"],
    ["typesafe/jev-1.13", "typesafe/jev-1.13"],
  ]) assert.equal(openrouterJevModel(requested), expected);
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? { answers, usage, model: "typesafe/jev-1.13-20260917" } : { answers, usage });
  }, async () => {
    const transport = openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" });
    assert.equal((await askJev(transport, input)).model, "typesafe/jev-1.13-20260917");
    assert.equal((await askJev(transport, { ...input, model: "typesafe/jev-1.12" })).model, "typesafe/jev-1.12");
    for (const model of ["typesafe/jev-latest", "~typesafe/jev-latest", "jev-1.13"]) await askJev(transport, { ...input, model });
    assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer sk-or-secret", "Content-Type": "application/json", "HTTP-Referer": "https://github.com/jkudish/discern-agent-tools", "X-Title": "discern", "X-OpenRouter-Title": "discern" });
    assert.equal(calls[0].init.signal, signal);
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "~typesafe/jev-latest", state: input.state, questions });
    assert.deepEqual(calls.map((call) => JSON.parse(call.init.body).model), ["~typesafe/jev-latest", "typesafe/jev-1.12", "~typesafe/jev-latest", "~typesafe/jev-latest", "typesafe/jev-1.13"]);
  });
  for (const model of [null, 1, "", " "]) {
    await withFetch(async () => Response.json({ answers, usage, model }), async () => {
      rejected(await askJev(openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }), input), "invalid_model", /question <response>.*model/);
    });
  }
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
  const env = { CLOUDFLARE_API_TOKEN: "low-secret", DISCERN_CLOUDFLARE_API_TOKEN: "high-secret", CLOUDFLARE_ACCOUNT_ID: "account" };
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

test("Vercel zero data retention is opt-in via DISCERN_VERCEL_ZERO_DATA_RETENTION", async () => {
  const result = { answers: { item: answers.item, yes: { type: "boolean", probability: 0.7 } }, usage: { inputTokens: 13, outputTokens: 3 } };
  for (const [value, expected] of [[undefined, false], ["", false], ["0", false], ["false", false], ["FaLsE", false], ["1", true], ["true", true], ["TRUE", true]]) {
    let call;
    const env = { AI_GATEWAY_API_KEY: "ai-secret", ...(value === undefined ? {} : { DISCERN_VERCEL_ZERO_DATA_RETENTION: value }) };
    await askJev(createVercelDriver(async (args) => { call = args; return result; }).create(env), input);
    assert.equal("providerOptions" in call, expected, `value ${JSON.stringify(value)}`);
    if (expected) assert.deepEqual(call.providerOptions, { gateway: { zeroDataRetention: true } });
  }
  for (const value of ["yes", "tru", " true ", "2"]) {
    let calls = 0;
    assert.throws(
      () => createVercelDriver(async () => { calls++; return result; }).create({ AI_GATEWAY_API_KEY: "ai-secret", DISCERN_VERCEL_ZERO_DATA_RETENTION: value }),
      /^Error: DISCERN_VERCEL_ZERO_DATA_RETENTION must be unset, empty, 0, false, 1, or true\.$/,
    );
    assert.equal(calls, 0);
    let fetches = 0;
    await withFetch(async () => { fetches++; return Response.json(result); }, async () => {
      const rejectedResult = await ask(input, { env: { AI_GATEWAY_API_KEY: "ai-secret", DISCERN_PROVIDER: "vercel", DISCERN_VERCEL_ZERO_DATA_RETENTION: value } });
      assert.deepEqual(rejectedResult, { ok: false, code: "configuration_error", message: "DISCERN_VERCEL_ZERO_DATA_RETENTION must be unset, empty, 0, false, 1, or true." });
    });
    assert.equal(fetches, 0);
  }
  const repeated = [];
  const transport = createVercelDriver(async (args) => { repeated.push(args.providerOptions); return result; }).create({ AI_GATEWAY_API_KEY: "ai-secret", DISCERN_VERCEL_ZERO_DATA_RETENTION: "true" });
  await askJev(transport, input);
  await askJev(transport, input);
  assert.deepEqual(repeated, [{ gateway: { zeroDataRetention: true } }, { gateway: { zeroDataRetention: true } }]);
  for (const env of [
    { TYPESAFE_API_KEY: "ts-secret", DISCERN_VERCEL_ZERO_DATA_RETENTION: "yes" },
    { OPENROUTER_API_KEY: "sk-or-secret", DISCERN_VERCEL_ZERO_DATA_RETENTION: "yes" },
    { CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "account", DISCERN_VERCEL_ZERO_DATA_RETENTION: "yes" },
  ]) assert.notEqual(resolveTransport(env).name, "vercel");
  const bodies = [];
  await withFetch(async (url, init) => { bodies.push(JSON.parse(init.body)); return Response.json(result); }, async () => {
    await ask(input, { env: { AI_GATEWAY_API_KEY: "ai-secret", DISCERN_VERCEL_ZERO_DATA_RETENTION: "1" } });
    await ask(input, { env: { AI_GATEWAY_API_KEY: "ai-secret" } });
  });
  assert.deepEqual(bodies[0].providerOptions, { gateway: { zeroDataRetention: true } });
  assert.equal("providerOptions" in bodies[1], false);
  const zdrFailures = [];
  await withFetch(async (url, init) => {
    zdrFailures.push(JSON.parse(init.body));
    return Response.json({ error: "body-secret", type: "no_providers_available" }, { status: 400 });
  }, async () => {
    rejected(await ask(input, { env: { AI_GATEWAY_API_KEY: "ai-secret", DISCERN_PROVIDER: "vercel", DISCERN_VERCEL_ZERO_DATA_RETENTION: "1" } }), "request_failed", /request failed/);
  });
  assert.equal(zdrFailures.length, 1);
  assert.deepEqual(zdrFailures[0].providerOptions, { gateway: { zeroDataRetention: true } });
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

test("typesafe transport retries retriable statuses, honors Retry-After, and reports the effective model", async () => {
  const driver = typesafe.create({ TYPESAFE_API_KEY: "ts-secret" });
  // 429 twice with Retry-After: 0, then 200: the call succeeds on the third attempt.
  let calls = 0;
  await withFetch(async () => {
    calls++;
    if (calls < 3) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    return Response.json({ answers, usage, model: "jev-1.13.0" });
  }, async () => {
    const result = await askJev(driver, input);
    assert.equal(result.ok, true);
    assert.equal(result.model, "jev-1.13.0", "the API's effective model, not the requested alias");
  });
  assert.equal(calls, 3);

  // Exhausted 429s surface as rate_limited with the status, never the body.
  calls = 0;
  await withFetch(async () => { calls++; return new Response("{}", { status: 429, headers: { "retry-after": "0" } }); }, async () => {
    rejected(await askJev(driver, input), "rate_limited", /rate limited \(HTTP 429\)/);
  });
  assert.equal(calls, 3);

  // Exhausted 5xx surface as unavailable.
  calls = 0;
  await withFetch(async () => { calls++; return new Response("{}", { status: 503, headers: { "retry-after": "0" } }); }, async () => {
    rejected(await askJev(driver, input), "unavailable", /unavailable \(HTTP 503\)/);
  });
  assert.equal(calls, 3);

  // Non-retriable statuses fail on the first attempt, with the status in the message.
  calls = 0;
  await withFetch(async () => { calls++; return new Response("{}", { status: 401 }); }, async () => {
    rejected(await askJev(driver, input), "request_failed", /request failed \(HTTP 401\)/);
  });
  assert.equal(calls, 1);

  // An absent response.model falls back to the requested alias.
  await withFetch(async () => Response.json({ answers, usage }), async () => {
    const result = await askJev(driver, input);
    assert.equal(result.ok, true);
    assert.equal(result.model, input.model);
  });

  // Aborting during the backoff window rejects promptly instead of sleeping on.
  const controller = new AbortController();
  calls = 0;
  await withFetch(async () => { calls++; return new Response("{}", { status: 429, headers: { "retry-after": "1" } }); }, async () => {
    setTimeout(() => controller.abort(), 25);
    const started = Date.now();
    rejected(await askJev(driver, { ...input, signal: controller.signal }), "request_failed", /request failed/);
    assert.ok(Date.now() - started < 500, "abort during backoff rejects promptly");
  });
});

test("typesafe transport retries 408/409, parses HTTP-date Retry-After, and caps long hints", async () => {
  const driver = typesafe.create({ TYPESAFE_API_KEY: "ts-secret" });
  const ok = () => Response.json({ answers, usage, model: "jev-1.13.0" });

  // 408 and 409 are retriable alongside 429 and 5xx.
  let calls = 0;
  await withFetch(async () => { calls++; return calls < 3 ? new Response("{}", { status: 408, headers: { "retry-after": "0" } }) : ok(); }, async () => {
    assert.equal((await askJev(driver, input)).ok, true);
  });
  assert.equal(calls, 3);
  calls = 0;
  await withFetch(async () => { calls++; return calls < 2 ? new Response("{}", { status: 409, headers: { "retry-after": "0" } }) : ok(); }, async () => {
    assert.equal((await askJev(driver, input)).ok, true);
  });
  assert.equal(calls, 2);

  // A past HTTP-date means retry now: no negative wait, and no jitter backfill.
  calls = 0;
  const past = new Date(Date.now() - 60_000).toUTCString();
  await withFetch(async () => { calls++; return calls < 2 ? new Response("{}", { status: 429, headers: { "retry-after": past } }) : ok(); }, async () => {
    const started = Date.now();
    assert.equal((await askJev(driver, input)).ok, true);
    assert.ok(Date.now() - started < 200, "expired Retry-After date retries immediately");
  });
  assert.equal(calls, 2);

  // A near-future HTTP-date is honored as a real delay, beyond jitter range.
  // +1700ms because HTTP-dates truncate to whole seconds: worst case the
  // parsed instant is 700ms out, best case 1700ms.
  calls = 0;
  const soon = new Date(Date.now() + 1_700).toUTCString();
  await withFetch(async () => { calls++; return calls < 2 ? new Response("{}", { status: 429, headers: { "retry-after": soon } }) : ok(); }, async () => {
    const started = Date.now();
    assert.equal((await askJev(driver, input)).ok, true);
    assert.ok(Date.now() - started >= 500, "future Retry-After date delays the retry");
  });
  assert.equal(calls, 2);

  // A far-future hint is capped at five seconds, never honored in full.
  calls = 0;
  const far = new Date(Date.now() + 60_000).toUTCString();
  await withFetch(async () => { calls++; return calls < 2 ? new Response("{}", { status: 429, headers: { "retry-after": far } }) : ok(); }, async () => {
    const started = Date.now();
    assert.equal((await askJev(driver, input)).ok, true);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4_700 && elapsed <= 5_700, `Retry-After capped at 5s (took ${elapsed}ms)`);
  });
  assert.equal(calls, 2);
});

test("typesafe transport does not retry network errors and passes malformed models to validation", async () => {
  const driver = typesafe.create({ TYPESAFE_API_KEY: "ts-secret" });

  // A rejecting fetch (DNS, socket, offline) fails on the first attempt — no retry.
  let calls = 0;
  await withFetch(async () => { calls++; throw new Error("ECONNREFUSED (fixture)"); }, async () => {
    rejected(await askJev(driver, input), "request_failed", /request failed/);
  });
  assert.equal(calls, 1);

  // A present-but-malformed model passes through untouched; shared validation rejects it.
  for (const model of ["", "   ", 42]) {
    await withFetch(async () => Response.json({ answers, usage, model }), async () => {
      rejected(await askJev(driver, input), "invalid_model", /effective model must be nonempty/);
    });
  }
});

test("ask classifies transport error statuses defensively and never throws", async () => {
  // A status getter that itself throws must not break the non-throwing contract.
  const throwingGetter = { name: "throwing-status", ask: async () => {
    const error = new Error("getter-secret boom");
    Object.defineProperty(error, "status", { get() { throw new Error("getter threw"); } });
    throw error;
  } };
  rejected(await ask(input, { transport: throwingGetter }), "request_failed", /request failed/);

  // Only integer statuses in 100–599 classify; 429 is rate_limited and 5xx unavailable.
  for (const [status, code, pattern] of [[429, "rate_limited", /rate limited \(HTTP 429\)/], [503, "unavailable", /unavailable \(HTTP 503\)/], [403, "request_failed", /request failed \(HTTP 403\)/]]) {
    const transport = { name: `status-${status}`, ask: async () => { throw Object.assign(new Error("http"), { status }); } };
    rejected(await ask(input, { transport }), code, pattern);
  }
  for (const status of [99, 600, 429.5, "429", null, undefined]) {
    const transport = { name: `status-${String(status)}`, ask: async () => { throw Object.assign(new Error("http"), { status }); } };
    rejected(await ask(input, { transport }), "request_failed", /request failed/);
  }
});

const openaiInput = {
  state: { title: "Export fails in Safari" },
  model: "jev-latest",
  signal,
  questions: {
    done: { type: "noul", instructions: "The goal is achieved", criteria: { true: "Page shows the result", false: "Not yet" } },
    route: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: null } },
    severity: { type: "score", instructions: "How severe?", criteria: ["Cosmetic", null, "Blocked"] },
  },
};
const openaiWire = {
  model: "gpt-6-luna",
  answers: [
    { type: "choice", name: "done", choice: false, probabilities: [{ value: true, probability: 0.3 }, { value: false, probability: 0.7 }], confidence: 0.4 },
    { type: "choice", name: "route", choice: "technical", probabilities: [{ value: "billing", probability: 0.1 }, { value: "technical", probability: 0.9 }], confidence: 0.8 },
    { type: "score", name: "severity", score: 1.21, probabilities: [{ value: 0, label: "0", probability: 0.02 }, { value: 1, label: "1", probability: 0.75 }, { value: 2, label: "2", probability: 0.23 }], confidence: 0.63 },
  ],
  usage: { input_tokens: 128, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, total_tokens: 128 },
};

test("OpenAI is explicit-only and prefers DISCERN_OPENAI_API_KEY", () => {
  assert.throws(() => resolveTransport({ OPENAI_API_KEY: "sk-secret" }), /No TYPESAFE_API_KEY/);
  assert.equal(resolveTransport({ OPENAI_API_KEY: "sk-secret", AI_GATEWAY_API_KEY: "ai-secret" }).name, "vercel");
  assert.equal(resolveTransport({ OPENAI_API_KEY: "sk-secret", DISCERN_PROVIDER: "OpenAI" }).name, "openai");
  assert.equal(resolveTransport({ DISCERN_OPENAI_API_KEY: "sk-secret", DISCERN_PROVIDER: "openai" }).name, "openai");
  assert.throws(() => resolveTransport({ DISCERN_PROVIDER: "openai", TYPESAFE_API_KEY: "ts-secret" }), (error) => error.message.startsWith("DISCERN_PROVIDER=openai") && /OPENAI_API_KEY/.test(error.message));
  assert.equal(openaiDecisionsModel("jev-latest"), "gpt-6-luna");
  assert.equal(openaiDecisionsModel("gpt-6-luna-2026-09-29"), "gpt-6-luna-2026-09-29");
});

test("OpenAI translates Jev questions and answers through the shared validator", async () => {
  const requests = [];
  await withFetch(async (url, init) => {
    requests.push({ url, init });
    return Response.json(openaiWire);
  }, async () => {
    const result = await ask(openaiInput, { env: { DISCERN_PROVIDER: "openai", OPENAI_API_KEY: "low-secret", DISCERN_OPENAI_API_KEY: "high-secret" } });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "gpt-6-luna");
    assert.deepEqual(result.usage, { input_tokens: 128, output_tokens: 0 });
    assert.deepEqual(result.answer, {
      done: { type: "noul", noul: 0.3 },
      route: { type: "choice", choice: "technical", probabilities: { billing: 0.1, technical: 0.9 }, confidence: 0.8 },
      severity: { type: "score", score: 1.21, probabilities: { "0": 0.02, "1": 0.75, "2": 0.23 }, confidence: 0.63 },
    });
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.openai.com/v1/decisions");
  assert.equal(requests[0].init.headers.Authorization, "Bearer high-secret");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: "gpt-6-luna",
    input: 'State (JSON):\n{\n  "title": "Export fails in Safari"\n}',
    questions: [
      { type: "choice", name: "done", instructions: "The goal is achieved", choices: [{ value: true, description: "Page shows the result" }, { value: false, description: "Not yet" }] },
      { type: "choice", name: "route", instructions: "Which team?", choices: [{ value: "billing", description: "Payments" }, { value: "technical" }] },
      { type: "score", name: "severity", instructions: "How severe?", levels: [{ label: "0", description: "Cosmetic" }, { label: "1" }, { label: "2", description: "Blocked" }] },
    ],
  });
  // Structured instructions (jev-mcp classify sends {task, item}) must reach the model, not vanish.
  await withFetch(async (_url, init) => {
    const sent = JSON.parse(init.body).questions;
    assert.equal(sent[0].instructions, '{"task":"Which class?","item":{"id":"i0","text":"Charged twice"}}');
    assert.deepEqual(sent[1], { type: "choice", name: "bare", instructions: "", choices: [{ value: true }, { value: false }] });
    return Response.json({ model: "gpt-6-luna", answers: [{ type: "choice", name: "i0", choice: "a", probabilities: [{ value: "a", probability: 1 }, { value: "b", probability: 0 }] }, { type: "choice", name: "bare", choice: true, probabilities: [{ value: true, probability: 0.5 }, { value: false, probability: 0.5 }] }] });
  }, async () => assert.equal((await ask({ ...openaiInput, questions: {
    i0: { type: "choice", instructions: { task: "Which class?", item: { id: "i0", text: "Charged twice" } }, criteria: { a: null, b: null } },
    bare: { type: "noul", instructions: null },
  } }, { env: { DISCERN_PROVIDER: "openai", OPENAI_API_KEY: "low-secret" } })).ok, true));
  // A string state is sent as-is, not JSON-quoted.
  await withFetch(async (_url, init) => {
    assert.equal(JSON.parse(init.body).input, "plain text");
    return Response.json(openaiWire);
  }, async () => assert.equal((await ask({ ...openaiInput, state: "plain text" }, { env: { DISCERN_PROVIDER: "openai", OPENAI_API_KEY: "low-secret" } })).ok, true));
});

test("OpenAI refusals, duplicate names, and typed choice values fail closed", async () => {
  const env = { DISCERN_PROVIDER: "openai", OPENAI_API_KEY: "low-secret" };
  const run = (answers) => withFetch(async () => Response.json({ ...openaiWire, answers }), () => ask(openaiInput, { env }));
  rejected(await run([openaiWire.answers[0], { type: "refusal", name: "route" }, openaiWire.answers[2]]), "refused", /question route: provider declined/);
  rejected(await run([...openaiWire.answers, openaiWire.answers[0]]), "malformed_answer", /answers must be an object/);
  rejected(await run([openaiWire.answers[0], { ...openaiWire.answers[1], probabilities: [{ value: true, probability: 0.1 }, { value: "technical", probability: 0.9 }] }, openaiWire.answers[2]]), "invalid_distribution", /question route/);
  rejected(await run({ done: { type: "noul", noul: 0.3 } }), "malformed_answer", /answers must be an object/);
  // A noul's boolean choice must be exactly {true, false}; string look-alikes or a missing side fail closed.
  for (const probabilities of [[{ value: "true", probability: 0.3 }, { value: "false", probability: 0.7 }], [{ value: true, probability: 1 }], [{ value: true, probability: 0.3 }, { value: false, probability: 0.7 }, { value: "maybe", probability: 0 }]]) {
    rejected(await run([{ ...openaiWire.answers[0], probabilities }, openaiWire.answers[1], openaiWire.answers[2]]), "invalid_noul", /question done/);
  }
  let sent = 0;
  await withFetch(async () => { sent++; return Response.json(openaiWire); }, async () => {
    rejected(await ask({ ...openaiInput, questions: { odd: { type: "rank" } } }, { env }), "request_failed", /provider openai: request failed$/);
  });
  assert.equal(sent, 0);
  await withFetch(async () => Response.json({ error: { message: "body-secret" } }, { status: 401 }), async () => {
    rejected(await ask(openaiInput, { env }), "request_failed", /HTTP 401/);
  });
});

test("OpenAI splits requests above 200 questions and merges answers and usage", async () => {
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`rel_${i}`, { type: "noul", instructions: `Is ${i} relevant?` }]));
  const sizes = [];
  const reply = (body, usage) => Response.json({ model: "gpt-6-luna", usage, answers: body.questions.map((q) => ({ type: "choice", name: q.name, choice: true, probabilities: [{ value: true, probability: 0.5 }, { value: false, probability: 0.5 }] })) });
  const env = { DISCERN_PROVIDER: "openai", OPENAI_API_KEY: "low-secret" };
  await withFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    sizes.push(body.questions.length);
    return reply(body, { input_tokens: body.questions.length, output_tokens: 0 });
  }, async () => {
    const result = await ask({ ...openaiInput, questions: many }, { env });
    assert.equal(result.ok, true, result.message);
    assert.equal(Object.keys(result.answer).length, 250);
    assert.deepEqual(result.usage, { input_tokens: 250, output_tokens: 0 });
  });
  assert.deepEqual(sizes.sort((a, b) => b - a), [200, 50]);
  // One malformed counter in either chunk is invalid usage, never a plausible sum.
  await withFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    return reply(body, { input_tokens: body.questions.length === 50 ? -1 : 200, output_tokens: 0 });
  }, async () => rejected(await ask({ ...openaiInput, questions: many }, { env }), "invalid_usage", /usage/));
});

test("score accepts an integer level or the distribution mean, nothing else", async () => {
  const score = { state: null, model: "jev", signal, questions: { rank: { type: "score", criteria: ["poor", "good", "great"] } } };
  const reply = (value, probabilities = { "0": 0, "1": 0.34, "2": 0.66 }) => carrier({ answers: { rank: { type: "score", score: value, probabilities, confidence: 0.48 } } });
  // Live TypeSafe reply: mean 1.66 reported as 1.65 after rounding.
  assert.equal((await askJev(reply(1.65), score)).answer.rank.score, 1.65);
  assert.equal((await askJev(reply(1), score)).ok, true);
  rejected(await askJev(reply(0.5), score), "invalid_distribution", /does not match the distribution mean/);
  rejected(await askJev(reply(1.6), score), "invalid_distribution", /does not match/);
  rejected(await askJev(reply(2.01), score), "invalid_choice", /outside criteria levels/);
  rejected(await askJev(reply(-0.01), score), "invalid_choice", /outside criteria levels/);
});

test("legacy JEV_ variables alias DISCERN_ ones through 1.x, and conflicts fail without values", async () => {
  // Alone, a legacy name is copied and reported; the new name wins when both agree.
  assert.deepEqual(normalizeDiscernEnv({ JEV_PROVIDER: "vercel", OTHER: "x" }), { env: { JEV_PROVIDER: "vercel", DISCERN_PROVIDER: "vercel", OTHER: "x" }, legacy: ["JEV_PROVIDER"] });
  assert.deepEqual(normalizeDiscernEnv({ JEV_PROVIDER: "vercel", DISCERN_PROVIDER: "vercel" }).legacy, ["JEV_PROVIDER"]);
  // Empty strings count as unset on either side (MCP clients pass "" for unconfigured variables).
  assert.equal(normalizeDiscernEnv({ JEV_PROVIDER: "vercel", DISCERN_PROVIDER: "" }).env.DISCERN_PROVIDER, "vercel");
  assert.deepEqual(normalizeDiscernEnv({ JEV_PROVIDER: "", DISCERN_PROVIDER: "typesafe" }), { env: { JEV_PROVIDER: "", DISCERN_PROVIDER: "typesafe" }, legacy: [] });
  assert.deepEqual(normalizeDiscernEnv({ JEV_: "x" }).legacy, []);
  assert.throws(() => normalizeDiscernEnv({ JEV_OPENAI_API_KEY: "high-secret", DISCERN_OPENAI_API_KEY: "low-secret" }), (error) => {
    assert.equal(error.message, "DISCERN_OPENAI_API_KEY and JEV_OPENAI_API_KEY are both set to different values; unset JEV_OPENAI_API_KEY.");
    return true;
  });

  // Every legacy driver setting still reaches its driver through the registry.
  assert.equal(resolveTransport({ JEV_PROVIDER: "openai", JEV_OPENAI_API_KEY: "sk-secret" }).name, "openai");
  assert.equal(resolveTransport({ JEV_CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "account" }).name, "cloudflare");
  let sent;
  await withFetch(async (url, init) => { sent = { url, init }; return Response.json(openaiWire); }, async () => {
    const result = await ask(openaiInput, { env: { JEV_PROVIDER: "openai", JEV_OPENAI_API_KEY: "high-secret", OPENAI_API_KEY: "low-secret", JEV_OPENAI_BASE_URL: "https://proxy.test/v1" } });
    assert.equal(result.ok, true, result.message);
  });
  assert.equal(sent.url, "https://proxy.test/v1/decisions");
  assert.equal(sent.init.headers.Authorization, "Bearer high-secret");
  const zdr = [];
  await withFetch(async (_url, init) => { zdr.push(JSON.parse(init.body).providerOptions); return Response.json({ answers: { item: answers.item, yes: { type: "boolean", probability: 0.7 } }, usage: { inputTokens: 1, outputTokens: 0 } }); },
    async () => assert.equal((await ask(input, { env: { AI_GATEWAY_API_KEY: "ai-secret", JEV_VERCEL_ZERO_DATA_RETENTION: "1" } })).ok, true));
  assert.deepEqual(zdr, [{ gateway: { zeroDataRetention: true } }]);

  // Through ask(), a conflict is a configuration error that names variables and leaks no values.
  rejected(await ask(input, { env: { DISCERN_PROVIDER: "typesafe", JEV_PROVIDER: "openai", TYPESAFE_API_KEY: "ts-secret" } }), "configuration_error", /^DISCERN_PROVIDER and JEV_PROVIDER are both set to different values; unset JEV_PROVIDER\.$/);
  rejected(await ask(input, { env: { JEV_PROVIDER: "typo" } }), "configuration_error", /Unknown DISCERN_PROVIDER/);
  // An empty DISCERN_PROVIDER means auto, not an unknown provider.
  assert.equal(resolveTransport({ DISCERN_PROVIDER: "", TYPESAFE_API_KEY: "ts-secret" }).name, "typesafe");
});

test("Cloudflare serves Clef on the same endpoint with a single-nested envelope", async () => {
  assert.equal(cloudflareModel("clef"), "@cf/cloudflare/clef");
  assert.equal(cloudflareModel("clef-flash"), "@cf/cloudflare/clef-flash");
  assert.equal(cloudflareModel("@cf/cloudflare/clef-2"), "@cf/cloudflare/clef-2");
  assert.equal(cloudflareModel("jev-latest"), "typesafe/jev");
  assert.equal(cloudflareModel("jev-1.13"), "typesafe/jev-1.13");
  assert.equal(cloudflareModel("clefx"), "typesafe/clefx");
  const env = { CLOUDFLARE_API_TOKEN: "low-secret", CLOUDFLARE_ACCOUNT_ID: "account" };
  // Live Clef reply shape (2026-10-07): answers directly under result, fractional score, legend, 4-decimal probabilities.
  const scoreQ = { ...input, model: "clef-flash", questions: { ...questions, sev: { type: "score", criteria: ["None", "Minor", "Major", "Critical"] } } };
  const clefAnswers = { ...answers, sev: { type: "score", score: 2.72, legend: { 0: "None", 1: "Minor", 2: "Major", 3: "Critical" }, probabilities: { 0: 0.015, 1: 0.0143, 2: 0.2064, 3: 0.7643 }, confidence: 0.5029 } };
  let body;
  await withFetch(async (_url, init) => { body = JSON.parse(init.body); return Response.json({ success: true, result: { model: "clef-flash", answers: clefAnswers, usage: { input_tokens: 346, output_tokens: 0 } } }); }, async () => {
    const result = await ask(scoreQ, { env: { ...env, DISCERN_PROVIDER: "cloudflare" } });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.model, "clef-flash");
    assert.equal(result.answer.sev.score, 2.72);
    assert.deepEqual(result.usage, { input_tokens: 346, output_tokens: 0 });
  });
  assert.equal(body.model, "@cf/cloudflare/clef-flash");
  assert.deepEqual(body.input.questions.sev.criteria, ["None", "Minor", "Major", "Critical"]);
});
