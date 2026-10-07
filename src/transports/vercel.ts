import type { BuiltinDriver } from "../provider.js";
import { CarrierFailure, CarrierHttpError, postJson } from "./http.js";

type Evaluation = (args: { apiKey: string; model: string; state: unknown; questions: Record<string, unknown>; signal: AbortSignal; maxAttempts?: number; providerOptions?: { gateway: { zeroDataRetention: true } } }) => Promise<any>;

function zeroDataRetention(value: string | undefined): boolean {
  if (value === undefined || value === "" || /^(0|false)$/i.test(value)) return false;
  if (/^(1|true)$/i.test(value)) return true;
  throw new CarrierFailure("DISCERN_VERCEL_ZERO_DATA_RETENTION must be unset, empty, 0, false, 1, or true.");
}

function evaluate({ apiKey, model, state, questions, signal, maxAttempts, providerOptions }: Parameters<Evaluation>[0]): Promise<any> {
  return postJson("https://ai-gateway.vercel.sh/v4/ai/evaluation-model", {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "ai-gateway-protocol-version": "0.0.1",
    "ai-gateway-auth-method": "api-key",
    "ai-evaluation-model-specification-version": "4",
    "ai-model-id": model,
  }, JSON.stringify({ state, questions, ...(providerOptions ? { providerOptions } : {}) }), { label: "Vercel AI Gateway", signal, maxAttempts });
}

// Internal factory seam: tests provide evaluate without replacing ESM exports.
export function createVercelDriver(evaluateRequest: Evaluation = evaluate): BuiltinDriver {
  return {
    name: "vercel",
    isConfigured: (env) => Boolean(env.AI_GATEWAY_API_KEY),
    assertConfigured(env) {
      if (!this.isConfigured(env)) throw new CarrierFailure("AI_GATEWAY_API_KEY is not set.");
    },
    create(env, options = {}) {
      this.assertConfigured(env);
      const key = env.AI_GATEWAY_API_KEY!;
      const providerOptions = zeroDataRetention(env.DISCERN_VERCEL_ZERO_DATA_RETENTION) ? { gateway: { zeroDataRetention: true as const } } : undefined;
      return {
        name: this.name,
        async ask({ state, questions, model, signal }) {
          const adaptedQuestions: [string, unknown][] = [];
          for (const [id, question] of Object.entries(questions)) {
            const q = question as { type: string; instructions?: unknown; criteria?: unknown };
            adaptedQuestions.push([id, { type: q.type === "noul" ? "boolean" : q.type, instructions: q.instructions, criteria: q.criteria }]);
          }
          const effective = model.startsWith("typesafe-ai/") ? model : "typesafe-ai/jev";
          let result: Awaited<ReturnType<Evaluation>>;
          try {
            result = await evaluateRequest({ apiKey: key, model: effective, state, questions: Object.fromEntries(adaptedQuestions), signal, maxAttempts: options.maxAttempts, ...(providerOptions ? { providerOptions } : {}) });
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (error instanceof CarrierHttpError) throw error;
            const status = (error as { statusCode?: unknown } | null)?.statusCode;
            if (typeof status === "number") throw new CarrierHttpError("Vercel AI Gateway", status);
            throw new CarrierFailure("Vercel AI Gateway request failed");
          }
          if (!result || typeof result !== "object" || Array.isArray(result)) throw new CarrierFailure("Vercel AI Gateway returned an invalid envelope (response omitted)");
          const usage = result.usage;
          const counters = usage !== null && typeof usage === "object" && !Array.isArray(usage)
            ? { input_tokens: Object.hasOwn(usage, "inputTokens") ? usage.inputTokens : 0, output_tokens: Object.hasOwn(usage, "outputTokens") ? usage.outputTokens : 0 }
            : usage === undefined ? { input_tokens: 0, output_tokens: 0 } : usage; // malformed: shared validation reports invalid_usage
          return { answers: adaptVercelAnswers(result.answers, result.providerMetadata), usage: counters, model: effective };
        },
      };
    },
  };
}

export function adaptVercelAnswers(answers: unknown, metadata: unknown): unknown {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return answers;
  const confidence = (metadata as any)?.typesafe?.confidence ?? {};
  const adapted: [string, unknown][] = [];
  for (const [id, answer] of Object.entries(answers)) {
    const value = answer as any;
    const answerConfidence = Object.hasOwn(confidence, id) ? confidence[id] : null;
    if (value?.type === "boolean") adapted.push([id, { type: "noul", noul: value.probability }]);
    else if (value?.type === "choice") adapted.push([id, { type: "choice", choice: value.choice, probabilities: value.probabilities, confidence: answerConfidence ?? null }]);
    else if (value?.type === "score") adapted.push([id, { type: "score", score: value.score, probabilities: value.probabilities, confidence: answerConfidence ?? null }]);
    else adapted.push([id, answer]);
  }
  return Object.fromEntries(adapted);
}

export const vercel = createVercelDriver();
