import assert from "node:assert/strict";
import { test } from "node:test";
import { ask, image, resolveTransport } from "../dist/index.js";

const env = { DISCERN_PROVIDER: "subq", SUBQ_API_KEY: "low-secret" };
const input = { state: ["structured", { value: 7 }], model: "latest", signal: new AbortController().signal };
const usage = { input_tokens: 13, output_tokens: 3 };
const questions = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, i % 3 === 0
  ? { type: "noul", instructions: { proposition: i } }
  : i % 3 === 1 ? { type: "choice", instructions: ["Route", i], criteria: { a: { name: "A" }, b: null } }
  : { type: "score", instructions: "Severity", criteria: [null, { name: "High" }] }]));
const answers = (qs) => Object.fromEntries(Object.entries(qs).reverse().map(([id, q]) => [id, q.type === "noul"
  ? { type: "noul", noul: Number(id.slice(1)) % 2 ? 0.1 : 0.9 }
  : q.type === "choice" ? { type: "choice", choice: "b", probabilities: { a: 0.17, b: 0.83 }, confidence: 0.66 }
  : { type: "score", score: 0.73, probabilities: { "0": 0.27, "1": 0.73 } }]));
const rejected = (result, code, pattern = /provider subq/) => {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.match(result.message, pattern);
  assert.doesNotMatch(result.message, /body-secret|high-secret|low-secret/);
};
async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("SubQ explicit selection, aliases, precedence, structured inputs and model mapping", async () => {
  assert.throws(() => resolveTransport({ SUBQ_API_KEY: "low-secret" }), /No TYPESAFE_API_KEY/);
  assert.equal(resolveTransport({ SUBQ_API_KEY: "low-secret", TYPESAFE_API_KEY: "ts-secret" }).name, "typesafe");
  rejected(await ask({ ...input, questions: questions(3) }, { env: { DISCERN_PROVIDER: "subq" } }), "configuration_error", /DISCERN_SUBQ_API_KEY or SUBQ_API_KEY/);
  for (const suffix of ["SUBQ_API_KEY", "SUBQ_BASE_URL"]) {
    rejected(await ask({ ...input, questions: questions(3) }, { env: { ...env, [`DISCERN_${suffix}`]: "high-secret", [`JEV_${suffix}`]: "low-secret" } }), "configuration_error", new RegExp(`DISCERN_${suffix} and JEV_${suffix}`));
  }
  for (const [e, model, auth, url, requested] of [
    [env, "latest", "Bearer low-secret", "https://api.subq.ai/v1/systemone", "subq-snap-preview"],
    [{ ...env, DISCERN_SUBQ_API_KEY: "high-secret", DISCERN_SUBQ_BASE_URL: "https://fixture.test/v1///" }, "jev-latest", "Bearer high-secret", "https://fixture.test/v1/systemone", "subq-snap-preview"],
    [{ JEV_PROVIDER: "SUBQ", JEV_SUBQ_API_KEY: "high-secret", JEV_SUBQ_BASE_URL: "https://legacy.test/v1" }, "subq-pinned", "Bearer high-secret", "https://legacy.test/v1/systemone", "subq-pinned"],
  ]) {
    const qs = questions(3);
    await withFetch(async (at, init) => {
      assert.equal(at, url);
      assert.equal(init.headers.Authorization, auth);
      assert.deepEqual(JSON.parse(init.body), { model: requested, state: input.state, questions: qs });
      return Response.json({ answers: answers(qs), usage, model: "subq-effective" });
    }, async () => {
      const result = await ask({ ...input, questions: qs, model }, { env: e });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.provider, "subq");
      assert.equal(result.model, "subq-effective");
      assert.deepEqual(result.usage, usage);
      assert.equal(result.answer.q2.score, 0.73);
      assert.deepEqual(result.answer.q1.probabilities, { a: 0.17, b: 0.83 });
    });
  }
});

test("SubQ batches 16/17/64 mixed questions by identity with aggregate usage and model", async () => {
  for (const [n, expectedSizes, expectedUsage] of [[16, [16], [32, 1]], [17, [16, 1], [65, 3]], [64, [16, 16, 16, 16], [134, 10]]]) {
    const qs = questions(n), sizes = [];
    await withFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      sizes.push(Object.keys(body.questions).length);
      return Response.json({ answers: answers(body.questions), usage: { input_tokens: 31 + sizes.length, output_tokens: sizes.length }, model: "subq-effective" });
    }, async () => {
      const result = await ask({ ...input, questions: qs }, { env });
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(Object.keys(result.answer).sort(), Object.keys(qs).sort());
      for (let i = 0; i < n; i++) {
        const answer = result.answer[`q${i}`];
        if (i % 3 === 0) assert.equal(answer.noul, i % 2 ? 0.1 : 0.9);
        else if (i % 3 === 1) assert.equal(answer.choice, "b");
        else assert.equal(answer.score, 0.73);
      }
      assert.deepEqual(result.usage, { input_tokens: expectedUsage[0], output_tokens: expectedUsage[1] });
      assert.equal(result.model, "subq-effective");
      assert.deepEqual(sizes, expectedSizes);
    });
  }
});

test("SubQ failed/malformed middle chunks expose no partial decisions and stop remaining requests", async () => {
  const qs = questions(64);
  for (const [mutate, code] of [
    [() => Response.json({ error: "body-secret" }, { status: 402 }), "request_failed"],
    [(b) => { delete b.answers.q16; return Response.json(b); }, "answer_id_mismatch"],
    [(b) => { b.answers.q0 = { type: "noul", noul: 1 }; return Response.json(b); }, "answer_id_mismatch"],
    [(b) => { b.answers.q16.choice = "a"; return Response.json(b); }, "invalid_choice"],
    [(b) => { b.usage.input_tokens = null; return Response.json(b); }, "invalid_usage"],
    [(b) => { b.model = null; return Response.json(b); }, "invalid_model"],
    [(b) => { b.model = "other-model"; return Response.json(b); }, "request_failed"],
    [(b) => { b.usage.input_tokens = Number.MAX_SAFE_INTEGER; return Response.json(b); }, "invalid_usage"],
  ]) {
    let calls = 0, observed = 0;
    await withFetch(async (_url, init) => {
      calls++;
      const body = { answers: answers(JSON.parse(init.body).questions), usage: { ...usage }, model: "subq-effective" };
      return calls === 2 ? mutate(body) : Response.json(body);
    }, async () => {
      rejected(await ask({ ...input, questions: qs }, { env, maxAttempts: 1, onReply: () => observed++ }), code);
      assert.equal(calls, 2);
      assert.equal(observed, 0);
    });
  }
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    await withFetch(async () => Response.json({ error: "body-secret low-secret" }, { status }), async () => {
      rejected(await ask({ ...input, questions: qs }, { env, maxAttempts: 1 }), status === 429 ? "rate_limited" : status >= 500 ? "unavailable" : "request_failed", new RegExp(`HTTP ${status}`));
    });
  }
});

test("SubQ cancellation and one shared deadline prevent later chunks", async () => {
  const qs = questions(64), caller = new AbortController();
  caller.abort(new Error("body-secret"));
  let calls = 0;
  await withFetch(async () => { calls++; throw Error("unexpected"); }, async () => {
    rejected(await ask({ ...input, questions: qs, signal: caller.signal }, { env }), "request_failed", /request failed$/);
    assert.equal(calls, 0);
  });
  for (const abort of [false, true]) {
    calls = 0;
    const controller = new AbortController();
    await withFetch(async (_url, init) => {
      calls++;
      if (calls === 1) return Response.json({ answers: answers(JSON.parse(init.body).questions), usage });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        if (abort) controller.abort(Error("body-secret"));
      });
    }, async () => {
      rejected(await ask({ ...input, questions: qs, signal: controller.signal }, { env, timeoutMs: 30 }), abort ? "request_failed" : "timeout", abort ? /request failed$/ : /deadline/);
      assert.equal(calls, 2);
    });
  }
});

test("SubQ repeats one state image across serial chunks, preflights later bodies, and stops after an invalid reply", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const request = { ...input, state: { photo: image(bytes) }, questions: questions(33) };
  let calls = 0;
  await withFetch(async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.deepEqual(body.images, [{ mediaType: "image/png", base64: bytes.toString("base64") }]);
    assert.equal(typeof body.state.photo, "string");
    return Response.json({ answers: answers(body.questions), usage, model: "subq-snap-preview" });
  }, async () => {
    const result = await ask(request, { env });
    assert.equal(result.ok, true, result.message);
    assert.equal(calls, 3);
    assert.equal(result.answer.q32.score, 0.73);
    rejected(await ask({ ...request, questions: { ...request.questions, q32: { type: "noul", instructions: "x".repeat(13 * 1024 * 1024) } } }, { env }), "invalid_image", /13 MiB/);
    assert.equal(calls, 3, "oversized final chunk must not spend on chunk 1");
  });
  calls = 0;
  await withFetch(async (_url, init) => {
    calls++;
    return Response.json({ answers: calls === 2 ? {} : answers(JSON.parse(init.body).questions), usage, model: "subq-snap-preview" });
  }, async () => {
    const result = await ask(request, { env });
    assert.equal(result.code, "answer_id_mismatch");
    assert.equal(calls, 2);
  });
});
