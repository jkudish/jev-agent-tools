import type { BuiltinDriver } from "../provider.js";
import { postJsonWithRetry } from "./http.js";

export const typesafe: BuiltinDriver = {
  name: "typesafe",
  isConfigured: (env) => Boolean(env.TYPESAFE_API_KEY),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new Error("TYPESAFE_API_KEY is not set.");
  },
  create(env) {
    this.assertConfigured(env);
    const key = env.TYPESAFE_API_KEY!;
    const baseURL = env.TYPESAFE_BASE_URL || "https://api.typesafe.ai";
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        const url = `${baseURL.replace(/\/$/, "")}/v1/systemone`;
        const response: { answers: unknown; usage?: { input_tokens?: number; output_tokens?: number }; model?: unknown } = await postJsonWithRetry(
          url,
          { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
          JSON.stringify({ state, questions, model }),
          signal,
          "TypeSafe API",
        );
        const usage = response?.usage;
        if (usage !== undefined && (typeof usage !== "object" || usage === null || Array.isArray(usage))) {
          throw new Error("TypeSafe API invalid usage (response omitted)");
        }
        // Report the effective model the API answered with, not the alias we
        // requested. Fall back to the alias only when the field is absent; a
        // present-but-malformed value passes through so the shared
        // invalid_model validation rejects it instead of masking it.
        const effectiveModel = Object.hasOwn(response, "model") ? response.model : model;
        return {
          answers: response?.answers,
          usage: {
            input_tokens: usage && Object.hasOwn(usage, "input_tokens") ? usage.input_tokens as number : 0,
            output_tokens: usage && Object.hasOwn(usage, "output_tokens") ? usage.output_tokens as number : 0,
          },
          model: effectiveModel as string,
        };
      },
    };
  },
};
