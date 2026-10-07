import type { BuiltinDriver } from "../provider.js";
import { postJsonWithRetry } from "./http.js";

// OpenAI Decisions API (public beta): https://developers.openai.com/api/docs/guides/decisions
// It is not Jev: a different model (gpt-6-luna) with its own calibration, so
// thresholds tuned on Jev do not transfer. Explicit-only (DISCERN_PROVIDER=openai)
// because OPENAI_API_KEY is common in environments that never chose it.

const LABEL = "OpenAI Decisions API";
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";
// Live-probed limits (2026-10-06): 200 questions per request, 255 choices, 10 levels.
const MAX_QUESTIONS_PER_REQUEST = 200;

/**
 * Jev questions refer to "the state", so name it, and pretty-print it. Measured
 * on captured discern-mcp and discern-browser requests, this removed a choice refusal
 * and raised agreement with TypeSafe over compact unlabeled JSON. String state
 * is sent unchanged.
 */
export function toDecisionInput(state: unknown): string {
  return typeof state === "string" ? state : `State (JSON):\n${JSON.stringify(state ?? null, null, 2)}`;
}

/** Map a Jev model name to an OpenAI Decisions model. Only the moving alias maps; anything else passes through. */
export function openaiDecisionsModel(model: string): string {
  return model === "jev-latest" ? OPENAI_DECISIONS_MODEL : model;
}

type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string | boolean; description?: string }[] }
  | { type: "score"; name: string; instructions: string; levels: { label: string; description?: string }[] };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const described = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Translate one Jev question. A noul becomes a two-option choice over the
 * booleans true and false, carrying its criteria as option descriptions; its
 * probability is the weight on true. Predicates have no place for those
 * outcome definitions, and folding them into the instructions measured worse
 * (23/30 vs 28/30 on a labeled set; it misread same-subject checks).
 * Score levels are labeled by index, matching Jev's score keys.
 */
export function toDecisionQuestion(name: string, question: unknown): DecisionQuestion {
  const q = record(question) ? question : {};
  // Jev instructions may be structured (e.g. {task, item}); OpenAI takes text.
  const instructions = typeof q.instructions === "string" ? q.instructions
    : q.instructions === null || q.instructions === undefined ? "" : JSON.stringify(q.instructions);
  if (q.type === "noul") {
    const outcomes = record(q.criteria) ? q.criteria : {};
    const option = (value: boolean) => described(outcomes[String(value)]) ? { value, description: outcomes[String(value)] as string } : { value };
    return { type: "choice", name, instructions, choices: [option(true), option(false)] };
  }
  if (q.type === "choice" && record(q.criteria)) {
    return { type: "choice", name, instructions, choices: Object.entries(q.criteria).map(([value, description]) => described(description) ? { value, description } : { value }) };
  }
  if (q.type === "score" && Array.isArray(q.criteria)) {
    return { type: "score", name, instructions, levels: q.criteria.map((description, index) => described(description) ? { label: String(index), description } : { label: String(index) }) };
  }
  throw new Error(`${LABEL} unsupported question (request not sent)`);
}

/** Probabilities arrive as [{value, probability}]; Jev keys them by criterion. Malformed or duplicate entries fail closed as null. */
function keyedProbabilities(entries: unknown, valid: (value: unknown) => boolean): Record<string, unknown> | null {
  if (!Array.isArray(entries)) return null;
  const keyed: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!record(entry) || !valid(entry.value) || seen.has(String(entry.value))) return null;
    seen.add(String(entry.value));
    keyed.push([String(entry.value), entry.probability]);
  }
  return Object.fromEntries(keyed);
}

/**
 * The weight on true from a boolean choice, or null (rejected as invalid_noul).
 * The distribution must be exactly {true, false}, both finite in [0,1] and
 * summing to 1 within two-decimal rounding, and the reported choice must be its
 * maximum (0.001 tie), so a contradictory answer can never become a noul.
 */
function trueWeight(answer: Record<string, unknown>): number | null {
  const keyed = keyedProbabilities(answer.probabilities, (value) => typeof value === "boolean");
  if (!keyed || Object.keys(keyed).length !== 2) return null;
  const [yes, no] = [keyed.true, keyed.false];
  const unit = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1;
  if (!unit(yes) || !unit(no) || Math.abs(yes + no - 1) > 0.01 + 1e-9) return null;
  if (typeof answer.choice !== "boolean" || (answer.choice ? yes : no) + 0.001 < Math.max(yes, no)) return null;
  return yes;
}

/**
 * Translate the answers array into Jev's keyed answers. `nouls` names the
 * questions sent as boolean choices. A refusal keeps type `refusal` so shared
 * validation reports `refused`. An unnamed or duplicate answer returns the raw
 * array, which validation rejects as malformed.
 */
export function adaptOpenAIAnswers(answers: unknown, nouls: ReadonlySet<string> = new Set()): unknown {
  if (!Array.isArray(answers)) return answers;
  const adapted: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!record(answer) || typeof answer.name !== "string" || seen.has(answer.name)) return answers;
    seen.add(answer.name);
    const confidence = answer.confidence === undefined ? null : answer.confidence;
    if (nouls.has(answer.name) && answer.type === "choice") adapted.push([answer.name, { type: "noul", noul: trueWeight(answer) }]);
    else if (answer.type === "predicate") adapted.push([answer.name, { type: "noul", noul: answer.probability }]);
    else if (answer.type === "choice") adapted.push([answer.name, { type: "choice", choice: answer.choice, probabilities: keyedProbabilities(answer.probabilities, (value) => typeof value === "string"), confidence }]);
    else if (answer.type === "score") adapted.push([answer.name, { type: "score", score: answer.score, probabilities: keyedProbabilities(answer.probabilities, Number.isSafeInteger), confidence }]);
    else if (answer.type === "refusal") adapted.push([answer.name, { type: "refusal" }]);
    else adapted.push([answer.name, answer]);
  }
  return Object.fromEntries(adapted);
}

export const openai: BuiltinDriver = {
  name: "openai",
  explicitOnly: true,
  isConfigured: (env) => Boolean(env.DISCERN_OPENAI_API_KEY || env.OPENAI_API_KEY),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new Error("DISCERN_OPENAI_API_KEY or OPENAI_API_KEY is not set.");
  },
  create(env) {
    this.assertConfigured(env);
    const key = (env.DISCERN_OPENAI_API_KEY || env.OPENAI_API_KEY)!;
    // Deliberately not OPENAI_BASE_URL: proxies configured for chat rarely serve /decisions.
    const url = `${(env.DISCERN_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/decisions`;
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        const effectiveRequest = openaiDecisionsModel(model);
        const input = toDecisionInput(state);
        const translated = Object.entries(questions).map(([name, question]) => toDecisionQuestion(name, question));
        if (!translated.length) throw new Error(`${LABEL} has no questions (request not sent)`);
        const nouls = new Set(Object.entries(questions).filter(([, question]) => record(question) && question.type === "noul").map(([name]) => name));
        const chunks: DecisionQuestion[][] = [];
        for (let i = 0; i < translated.length; i += MAX_QUESTIONS_PER_REQUEST) chunks.push(translated.slice(i, i + MAX_QUESTIONS_PER_REQUEST));
        // Chunks share the input and run concurrently; any failure fails the
        // call and cancels its siblings, so no request or retry outlives ask().
        const siblings = new AbortController();
        const cancel = () => siblings.abort(signal.reason);
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
        let replies: unknown[];
        try {
          replies = await Promise.all(chunks.map((chunk) => postJsonWithRetry(
            url,
            { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
            JSON.stringify({ model: effectiveRequest, input, questions: chunk }),
            siblings.signal,
            LABEL,
          )));
        } catch (error) {
          siblings.abort();
          // A caller's abort keeps its own reason; sibling cancellation is internal.
          if (signal.aborted) throw signal.reason;
          throw error;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
        let answers: unknown[] | null = [];
        let inputTokens = 0;
        let outputTokens = 0;
        // Absent counters are zero; a malformed one poisons the sum with NaN so
        // shared validation reports invalid_usage instead of a plausible total.
        const counter = (usage: Record<string, unknown> | undefined, field: string) => {
          if (!usage || !Object.hasOwn(usage, field)) return 0;
          const value = usage[field];
          return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : NaN;
        };
        for (const reply of replies) {
          if (!record(reply)) throw new Error(`${LABEL} invalid envelope (response omitted)`);
          const usage = reply.usage;
          if (usage !== undefined && !record(usage)) throw new Error(`${LABEL} invalid usage (response omitted)`);
          inputTokens += counter(usage, "input_tokens");
          outputTokens += counter(usage, "output_tokens");
          // A non-array answers field is malformed; null fails validation closed.
          if (answers && Array.isArray(reply.answers)) answers.push(...reply.answers);
          else answers = null;
        }
        // Report the effective model; a present-but-malformed value reaches validation.
        const first = replies[0] as Record<string, unknown>;
        return {
          answers: adaptOpenAIAnswers(answers, nouls),
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          model: (Object.hasOwn(first, "model") ? first.model : effectiveRequest) as string,
        };
      },
    };
  },
};
