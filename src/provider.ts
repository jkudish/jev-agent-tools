import { typesafe } from "./transports/typesafe.js";
import { openrouter } from "./transports/openrouter.js";
import { cloudflare } from "./transports/cloudflare.js";
import { vercel } from "./transports/vercel.js";
import { openai } from "./transports/openai.js";
import { normalizeDiscernEnv } from "./env.js";

export interface DiscernTransportInput {
  state: unknown;
  questions: Record<string, unknown>;
  model: string;
  signal: AbortSignal;
}

export interface DiscernTransportReply {
  answers: unknown;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export interface DiscernTransport {
  readonly name: string;
  ask(input: DiscernTransportInput): Promise<DiscernTransportReply>;
}

export interface BuiltinDriver {
  readonly name: "typesafe" | "openrouter" | "cloudflare" | "vercel" | "openai";
  /** Never auto-detected; selected only by DISCERN_PROVIDER. */
  readonly explicitOnly?: true;
  isConfigured(env: Env): boolean;
  assertConfigured(env: Env): void;
  create(env: Env): DiscernTransport;
}

export type Env = Record<string, string | undefined>;

/** @deprecated Use DiscernTransportInput. Removed in 2.0. */
export type JevTransportInput = DiscernTransportInput;
/** @deprecated Use DiscernTransportReply. Removed in 2.0. */
export type JevTransportReply = DiscernTransportReply;
/** @deprecated Use DiscernTransport. Removed in 2.0. */
export type JevTransport = DiscernTransport;

export type DiscernAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number | null }
  // Score is the probability-weighted mean of level indices (it can fall
  // between levels); some carriers report an integer level instead.
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number | null };

/** @deprecated Use DiscernAnswer. Removed in 2.0. */
export type JevAnswer = DiscernAnswer;

export type RejectionCode = "request_failed" | "rate_limited" | "unavailable" | "configuration_error" | "malformed_answer" | "answer_id_mismatch" | "invalid_criteria" | "invalid_distribution" | "invalid_choice" | "invalid_noul" | "refused" | "invalid_confidence" | "invalid_usage" | "invalid_model";

export type AskResult =
  | { ok: true; answer: Record<string, DiscernAnswer>; usage: DiscernTransportReply["usage"]; model: string; provider: string }
  | { ok: false; code: RejectionCode; message: string };

export interface AskConfig { env?: Env; transport?: DiscernTransport }

const drivers: readonly BuiltinDriver[] = [typesafe, openrouter, cloudflare, vercel, openai];

/**
 * Pick a carrier from the environment. Legacy JEV_<X> variables are read as
 * DISCERN_<X> through 1.x (see normalizeDiscernEnv); drivers see only the
 * DISCERN_ names.
 */
export function resolveTransport(input: Env = process.env): DiscernTransport {
  const { env } = normalizeDiscernEnv(input);
  const explicit = (env.DISCERN_PROVIDER || "auto").toLowerCase();
  if (explicit !== "auto") {
    const driver = drivers.find((candidate) => candidate.name === explicit);
    if (!driver) throw new Error("Unknown DISCERN_PROVIDER; choose typesafe, openrouter, cloudflare, vercel, openai, or auto.");
    try {
      driver.assertConfigured(env);
    } catch (error) {
      throw new Error(`DISCERN_PROVIDER=${driver.name} but ${(error as Error).message}`);
    }
    return driver.create(env);
  }
  const driver = drivers.find((candidate) => !candidate.explicitOnly && candidate.isConfigured(env));
  if (!driver) {
    throw new Error("No TYPESAFE_API_KEY, OPENROUTER_API_KEY (sk-or-), Cloudflare token (CLOUDFLARE_API_TOKEN or DISCERN_CLOUDFLARE_API_TOKEN) + CLOUDFLARE_ACCOUNT_ID, or AI_GATEWAY_API_KEY found. Set one, or DISCERN_PROVIDER to choose explicitly (DISCERN_PROVIDER=openai uses DISCERN_OPENAI_API_KEY or OPENAI_API_KEY).");
  }
  return driver.create(env);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ROUNDING_STEP = 0.005; // worst-case error of one probability rounded to two decimals
const MAX_SUM_DRIFT = 0.05;

function distribution(value: unknown, keys: string[]): { ok: true; probabilities: Record<string, number> } | { ok: false; reason: string } {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    return { ok: false, reason: "distribution must contain exactly the criteria keys" };
  }
  let sum = 0;
  const entries: [string, number][] = [];
  for (const key of keys) {
    const probability = value[key];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { ok: false, reason: "distribution must contain finite probabilities in [0,1]" };
    }
    entries.push([key, probability]);
    sum += probability as number;
  }
  // Upstream distributions are rounded to two decimals, so each nonzero entry
  // can be off by up to 0.005 and the drift grows with how many options carry
  // weight (a results page with 8 live options can legitimately sum to 0.98).
  // Permit that rounding drift (never less than one percent, never more than
  // five, so garbage still fails) and a 0.001 selection tie, but not a
  // different winner. The epsilon keeps an exact 1.01 from failing on IEEE-754.
  const nonzero = entries.filter(([, probability]) => probability > 0).length;
  const tolerance = Math.min(MAX_SUM_DRIFT, Math.max(0.01, ROUNDING_STEP * nonzero)) + 1e-9;
  if (Math.abs(sum - 1) > tolerance) return { ok: false, reason: "distribution must sum to approximately 1" };
  return { ok: true, probabilities: Object.fromEntries(entries) };
}

export async function ask(input: DiscernTransportInput, config: AskConfig = {}): Promise<AskResult> {
  let transport: DiscernTransport;
  try {
    transport = config.transport ?? resolveTransport(config.env);
  } catch (error) {
    // Registry errors are fixed strings; never echo arbitrary driver exceptions.
    const message = error instanceof Error && /^(Unknown DISCERN_PROVIDER|No TYPESAFE_API_KEY|DISCERN_PROVIDER=|DISCERN_VERCEL_ZERO_DATA_RETENTION must|DISCERN_[A-Z0-9_]+ and JEV_[A-Z0-9_]+ are both set)/.test(error.message)
      ? error.message : "Discern provider configuration failed";
    return { ok: false, code: "configuration_error", message };
  }
  // Injected transport names are untrusted and never included in error text.
  const provider = typeof transport.name === "string" && /^(typesafe|openrouter|cloudflare|vercel|openai|fixture)$/.test(transport.name) ? transport.name : "unknown";
  let reply: DiscernTransportReply;
  try {
    reply = await transport.ask(input);
  } catch (error) {
    // Transports may attach a numeric `status` to HTTP failures; classify it
    // for callers. The read itself is guarded — an injected transport whose
    // error throws from a status getter must not break the non-throwing
    // contract — and the status is a number, never a response body.
    let status: unknown;
    try {
      status = (error as { status?: unknown } | null | undefined)?.status;
    } catch {
      status = undefined;
    }
    const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status < 600 ? status : undefined;
    if (httpStatus === 429) return { ok: false, code: "rate_limited", message: `Discern provider ${provider}: rate limited (HTTP 429)` };
    if (httpStatus !== undefined && httpStatus >= 500) return { ok: false, code: "unavailable", message: `Discern provider ${provider}: unavailable (HTTP ${httpStatus})` };
    if (httpStatus !== undefined) return { ok: false, code: "request_failed", message: `Discern provider ${provider}: request failed (HTTP ${httpStatus})` };
    return { ok: false, code: "request_failed", message: `Discern provider ${provider}: request failed` };
  }
  const fail = (id: string, code: RejectionCode, reason: string): AskResult => ({ ok: false, code, message: `Discern provider ${provider} question ${id}: ${reason}` });
  if (!record(input.questions)) return fail("<response>", "invalid_criteria", "questions must be an object");
  if (!record(reply) || !record(reply.answers)) return fail("<response>", "malformed_answer", "answers must be an object");
  const answers = reply.answers as Record<string, unknown>;
  const ids = Object.keys(input.questions);
  for (const id of ids) if (!Object.hasOwn(answers, id)) return fail(id, "answer_id_mismatch", "missing answer");
  if (Object.keys(answers).length !== ids.length) return fail("<response>", "answer_id_mismatch", "unexpected answer ID");
  const validated: [string, DiscernAnswer][] = [];
  for (const id of ids) {
    const question = input.questions[id];
    const answer = answers[id];
    if (record(answer) && answer.type === "refusal") return fail(id, "refused", "provider declined to answer");
    if (!record(question) || !record(answer) || answer.type !== question.type) return fail(id, "malformed_answer", "missing answer or wrong type");
    if (question.type === "noul") {
      if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return fail(id, "invalid_noul", "noul must be finite in [0,1]");
      validated.push([id, { type: "noul", noul: answer.noul as number }]);
      continue;
    }
    const keys = question.type === "score" && Array.isArray(question.criteria)
      ? question.criteria.map((_, index) => String(index))
      : question.type === "choice" && record(question.criteria) ? Object.keys(question.criteria) : null;
    if (!keys?.length) return fail(id, "invalid_criteria", "invalid question criteria");
    const checked = distribution(answer.probabilities, keys);
    if (!checked.ok) return fail(id, "invalid_distribution", checked.reason);
    const probabilities = checked.probabilities;
    const confidence = answer.confidence === undefined ? null : answer.confidence;
    if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence))) return fail(id, "invalid_confidence", "confidence must be finite or null");
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !keys.includes(answer.choice)) return fail(id, "invalid_choice", "choice is outside criteria");
      if (probabilities[answer.choice as string] + 0.001 < Math.max(...Object.values(probabilities))) return fail(id, "invalid_choice", "choice is not a distribution maximum");
      validated.push([id, { type: "choice", choice: answer.choice as string, probabilities, confidence: confidence as number | null }]);
    } else if (question.type === "score") {
      const score = answer.score;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > keys.length - 1) return fail(id, "invalid_choice", "score is outside criteria levels");
      // An integer names a level. A fractional score is the distribution's
      // mean, within the two-decimal rounding of each weighted probability.
      if (!Number.isInteger(score)) {
        let mean = 0;
        let weight = 1;
        for (const key of keys) {
          mean += Number(key) * probabilities[key];
          if (probabilities[key] > 0) weight += Number(key);
        }
        if (Math.abs(mean - score) > Math.max(0.02, ROUNDING_STEP * weight) + 1e-9) return fail(id, "invalid_distribution", "score does not match the distribution mean");
      }
      validated.push([id, { type: "score", score, probabilities, confidence: confidence as number | null }]);
    } else return fail(id, "malformed_answer", "unsupported question type");
  }
  if (!record(reply.usage) || !Number.isSafeInteger(reply.usage.input_tokens) || (reply.usage.input_tokens as number) < 0 || !Number.isSafeInteger(reply.usage.output_tokens) || (reply.usage.output_tokens as number) < 0) {
    return fail("<response>", "invalid_usage", "usage counters must be non-negative safe integers");
  }
  if (typeof reply.model !== "string" || !reply.model.trim()) return fail("<response>", "invalid_model", "effective model must be nonempty");
  return { ok: true, answer: Object.fromEntries(validated), usage: reply.usage as DiscernTransportReply["usage"], provider, model: reply.model as string };
}
