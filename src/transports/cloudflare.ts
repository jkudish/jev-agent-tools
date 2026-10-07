import type { BuiltinDriver } from "../provider.js";
import { CarrierFailure, apiUrl, postJson, usageOf } from "./http.js";

// Cloudflare's own Clef decision models speak the same wire format as Jev and
// run on the same Workers AI endpoint: https://blog.cloudflare.com/clef-decision-models/
const CLEF_MODELS = new Set(["clef", "clef-flash"]);

/**
 * Map a model name to a Workers AI model id. `clef` and `clef-flash` name
 * Cloudflare's Clef models; any `@cf/` id passes through; everything else is a
 * TypeSafe Jev name, where `latest` and `jev-latest` map to Cloudflare's single
 * `typesafe/jev` alias.
 */
export function cloudflareModel(model: string): string {
  if (CLEF_MODELS.has(model)) return `@cf/cloudflare/${model}`;
  if (model.startsWith("@cf/") || model.startsWith("typesafe/")) return model;
  return `typesafe/${model === "jev-latest" || model === "latest" ? "jev" : model}`;
}

export const cloudflare: BuiltinDriver = {
  name: "cloudflare",
  isConfigured: (env) => Boolean((env.DISCERN_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN) && env.CLOUDFLARE_ACCOUNT_ID),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new CarrierFailure("a Cloudflare API token (CLOUDFLARE_API_TOKEN or DISCERN_CLOUDFLARE_API_TOKEN) and CLOUDFLARE_ACCOUNT_ID are not both set.");
  },
  create(env, options = {}) {
    this.assertConfigured(env);
    const token = env.DISCERN_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
    const url = apiUrl(env.DISCERN_CLOUDFLARE_BASE_URL || "https://api.cloudflare.com/client/v4", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run`);
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        const slug = cloudflareModel(model);
        const body = await postJson(url, { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          JSON.stringify({ model: slug, input: { state, questions } }), { label: "Cloudflare AI run", signal, maxAttempts: options.maxAttempts }) as Record<string, any> | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new CarrierFailure("Cloudflare AI run returned an invalid envelope (response omitted)");
        // success:false and a non-Completed state are failures; their upstream text never reaches a message.
        if (body.success === false) throw new CarrierFailure("Cloudflare AI run did not succeed (response omitted)");
        // Jev double-nests the model output under result.result; Clef returns it directly under result.
        const outer = body.result;
        if (outer && typeof outer.state === "string" && outer.state !== "Completed") throw new CarrierFailure("Cloudflare AI run did not complete (response omitted)");
        const payload = outer?.result ?? outer ?? body;
        return { answers: payload?.answers, usage: usageOf(payload?.usage), model: payload?.model ?? slug };
      },
    };
  },
};
