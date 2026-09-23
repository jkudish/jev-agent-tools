import type { BuiltinDriver } from "../provider.js";

type Evaluation = (args: { apiKey: string; model: string; state: unknown; questions: Record<string, unknown>; signal: AbortSignal }) => Promise<any>;

async function evaluate({ apiKey, model, state, questions, signal }: Parameters<Evaluation>[0]): Promise<any> {
  const response = await fetch("https://ai-gateway.vercel.sh/v4/ai/evaluation-model", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": model,
    },
    body: JSON.stringify({ state, questions }),
    signal,
  });
  if (!response.ok) throw { statusCode: response.status };
  return response.json();
}

// Internal factory seam: tests provide evaluate without replacing ESM exports.
export function createVercelDriver(evaluateRequest: Evaluation = evaluate): BuiltinDriver {
  return {
    name: "vercel",
    isConfigured: (env) => Boolean(env.AI_GATEWAY_API_KEY),
    assertConfigured(env) {
      if (!this.isConfigured(env)) throw new Error("AI_GATEWAY_API_KEY is not set.");
    },
    create(env) {
      this.assertConfigured(env);
      const key = env.AI_GATEWAY_API_KEY!;
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
            result = await evaluateRequest({ apiKey: key, model: effective, state, questions: Object.fromEntries(adaptedQuestions), signal });
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            const status = (error as { statusCode?: unknown }).statusCode;
            throw new Error(`Vercel AI Gateway ${typeof status === "number" ? `HTTP ${status}` : "request failed"} (response omitted)`);
          }
          const usage = result.usage;
          if (usage !== undefined && (typeof usage !== "object" || usage === null || Array.isArray(usage))) {
            throw new Error("Vercel AI Gateway invalid usage (response omitted)");
          }
          return {
            answers: adaptVercelAnswers(result.answers, result.providerMetadata),
            usage: {
              input_tokens: usage && Object.hasOwn(usage, "inputTokens") ? usage.inputTokens as number : 0,
              output_tokens: usage && Object.hasOwn(usage, "outputTokens") ? usage.outputTokens as number : 0,
            },
            model: effective,
          };
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
