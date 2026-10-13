import { validateReply, type BuiltinDriver, type DiscernTransportReply } from "../provider.js";
import { apiUrl, CarrierFailure, CarrierRejection, postJson, usageOf } from "./http.js";

const LABEL = "SubQ Decisions API";
const DEFAULT_MODEL = "subq-snap-preview";
// Live-probed 2026-10-13: 16 succeeds, 17 receives HTTP 422.
const MAX_QUESTIONS = 16;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export const subq: BuiltinDriver = {
  name: "subq",
  explicitOnly: true,
  isConfigured: (env) => Boolean(env.DISCERN_SUBQ_API_KEY || env.SUBQ_API_KEY),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new CarrierFailure("DISCERN_SUBQ_API_KEY or SUBQ_API_KEY is not set.");
  },
  create(env, options = {}) {
    this.assertConfigured(env);
    const key = (env.DISCERN_SUBQ_API_KEY || env.SUBQ_API_KEY)!;
    const url = apiUrl(env.DISCERN_SUBQ_BASE_URL || "https://api.subq.ai/v1", "/systemone");
    return {
      name: this.name,
      async ask(input) {
        const { state, questions, model, signal } = input;
        const requested = model === "latest" || model === "jev-latest" ? DEFAULT_MODEL : model;
        const entries = Object.entries(questions);
        if (!entries.length) throw new CarrierFailure(`${LABEL} has no questions (request not sent)`);
        const merged: [string, unknown][] = [];
        const usage = { input_tokens: 0, output_tokens: 0 };
        let effective: string | undefined;
        // Serial chunks share ask()'s deadline. A failed chunk exposes no
        // partial reply to onReply consumers and sends no remaining requests.
        for (let start = 0; start < entries.length; start += MAX_QUESTIONS) {
          signal.throwIfAborted();
          const chunk = Object.fromEntries(entries.slice(start, start + MAX_QUESTIONS));
          const body = await postJson(url, { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            JSON.stringify({ model: requested, state, questions: chunk }), { label: LABEL, signal, maxAttempts: options.maxAttempts });
          signal.throwIfAborted();
          if (!record(body)) throw new CarrierFailure(`${LABEL} invalid envelope (response omitted)`);
          const reply: DiscernTransportReply = {
            answers: body.answers,
            usage: usageOf(body.usage),
            model: (Object.hasOwn(body, "model") ? body.model : requested) as string,
          };
          const checked = validateReply({ ...input, questions: chunk }, reply, "subq");
          if (!checked.ok) throw new CarrierRejection(checked);
          if (effective !== undefined && effective !== reply.model) throw new CarrierFailure(`${LABEL} inconsistent chunk models (response omitted)`);
          effective = reply.model;
          merged.push(...Object.entries(reply.answers as Record<string, unknown>));
          usage.input_tokens += reply.usage.input_tokens;
          usage.output_tokens += reply.usage.output_tokens;
          if (!Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens)) {
            throw new CarrierRejection({ ok: false, code: "invalid_usage", message: "Discern provider subq question <response>: usage counters must be non-negative safe integers" });
          }
        }
        return { answers: Object.fromEntries(merged), usage, model: effective! };
      },
    };
  },
};
