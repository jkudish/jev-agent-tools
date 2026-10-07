import type { BuiltinDriver } from "../provider.js";
import { postJson, usageOf } from "./http.js";

/**
 * Any endpoint that speaks the System One contract: POST { model, state,
 * questions } and reply { answers, usage, model? }. DISCERN_API_BASE_URL is
 * the full POST URL. Auto-selected only when no other carrier is configured.
 * The neutral `latest` alias is sent as `jev-latest`; other names pass through.
 */
export const compatible: BuiltinDriver = {
  name: "compatible",
  isConfigured: (env) => Boolean(env.DISCERN_API_KEY && env.DISCERN_API_BASE_URL),
  assertConfigured(env) {
    const missing = ["DISCERN_API_KEY", "DISCERN_API_BASE_URL"].filter((name) => !env[name]);
    if (missing.length) throw new Error(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set.`);
  },
  create(env, options = {}) {
    this.assertConfigured(env);
    const key = env.DISCERN_API_KEY!;
    const url = env.DISCERN_API_BASE_URL!;
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        const requested = model === "latest" ? "jev-latest" : model;
        const body = await postJson(url, { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          JSON.stringify({ model: requested, state, questions }), { label: "Jev-compatible endpoint", signal, maxAttempts: options.maxAttempts }) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Jev-compatible endpoint returned an invalid envelope (response omitted)");
        return { answers: body.answers, usage: usageOf(body.usage ?? undefined), model: (typeof body.model === "string" ? body.model : body.model == null ? requested : body.model) as string };
      },
    };
  },
};
