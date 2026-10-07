import type { BuiltinDriver } from "../provider.js";
import { CarrierFailure, apiUrl, postJson, usageOf } from "./http.js";

const TITLE = "discern";
const REFERER = "https://github.com/jkudish/discern-agent-tools";
const LATEST = "~typesafe/jev-latest";

/** Map a model name to OpenRouter's Decisions API model ID. `latest` and `jev-latest` follow OpenRouter's moving Jev alias. */
export function openrouterModel(model: string): string {
  if (model === "latest" || model === "jev-latest" || model === "typesafe/jev-latest" || model === LATEST) return LATEST;
  return model.startsWith("typesafe/") ? model : `typesafe/${model}`;
}

const SAFE_ERROR_TYPES = new Set(["max_tokens_exceeded"]);

/**
 * OpenRouter's Decisions envelope is { error: { code, message } }. For an
 * oversized Jev request, live responses wrap TypeSafe's typed body inside the
 * message as `HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}`.
 * Only allow-listed constants come back; never upstream text.
 * Contributed in jkudish/jev-mcp#57 by @nicolas-found42.
 */
export function openrouterErrorType(body: string): string | undefined {
  try {
    const message = JSON.parse(body)?.error?.message;
    if (typeof message !== "string") return undefined;
    const wrapped = message.match(/^HTTP 4\d\d: (\{.*\})$/s);
    if (!wrapped) return undefined;
    const code = JSON.parse(wrapped[1])?.detail?.error_type;
    return typeof code === "string" && SAFE_ERROR_TYPES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export const openrouter: BuiltinDriver = {
  name: "openrouter",
  isConfigured: (env) => /^sk-or-/.test(env.OPENROUTER_API_KEY ?? ""),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new CarrierFailure("OPENROUTER_API_KEY is not set or not an sk-or- key.");
  },
  create(env, options = {}) {
    this.assertConfigured(env);
    const key = env.OPENROUTER_API_KEY!;
    const url = apiUrl(env.DISCERN_OPENROUTER_BASE_URL || "https://openrouter.ai/api", "/alpha/decisions");
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        const slug = openrouterModel(model);
        const body = await postJson(url, {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": REFERER,
          "X-Title": TITLE,
          "X-OpenRouter-Title": TITLE,
        }, JSON.stringify({ model: slug, state, questions }), { label: "OpenRouter decisions API", signal, maxAttempts: options.maxAttempts, errorDetail: openrouterErrorType }) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new CarrierFailure("OpenRouter decisions API returned an invalid envelope (response omitted)");
        // Report the effective snapshot; a present-but-malformed value reaches shared validation.
        return { answers: body.answers, usage: usageOf(body.usage), model: (Object.hasOwn(body, "model") ? body.model : slug) as string };
      },
    };
  },
};

/** @deprecated Use openrouterModel. Removed in 2.0. */
export const openrouterJevModel = openrouterModel;
