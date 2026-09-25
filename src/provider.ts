import { typesafe } from "./transports/typesafe.js";
import { openrouter } from "./transports/openrouter.js";
import { cloudflare } from "./transports/cloudflare.js";
import { vercel } from "./transports/vercel.js";

export interface JevTransportInput {
  state: unknown;
  questions: Record<string, unknown>;
  model: string;
  signal: AbortSignal;
}

export interface JevTransportReply {
  answers: unknown;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export interface JevTransport {
  readonly name: string;
  ask(input: JevTransportInput): Promise<JevTransportReply>;
}

export interface BuiltinDriver {
  readonly name: "typesafe" | "openrouter" | "cloudflare" | "vercel";
  isConfigured(env: Env): boolean;
  assertConfigured(env: Env): void;
  create(env: Env): JevTransport;
}

export type Env = Record<string, string | undefined>;

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number | null }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number | null };

export type RejectionCode = "request_failed" | "configuration_error" | "malformed_answer" | "answer_id_mismatch" | "invalid_criteria" | "invalid_distribution" | "invalid_choice" | "invalid_noul" | "invalid_confidence" | "invalid_usage" | "invalid_model";

export type AskResult =
  | { ok: true; answer: Record<string, JevAnswer>; usage: JevTransportReply["usage"]; model: string; provider: string }
  | { ok: false; code: RejectionCode; message: string };

export interface AskConfig { env?: Env; transport?: JevTransport }

const drivers: readonly BuiltinDriver[] = [typesafe, openrouter, cloudflare, vercel];

export function resolveTransport(env: Env = process.env): JevTransport {
  const explicit = (env.JEV_PROVIDER ?? "auto").toLowerCase();
  if (explicit !== "auto") {
    const driver = drivers.find((candidate) => candidate.name === explicit);
    if (!driver) throw new Error("Unknown JEV_PROVIDER; choose typesafe, openrouter, cloudflare, vercel, or auto.");
    try {
      driver.assertConfigured(env);
    } catch (error) {
      throw new Error(`JEV_PROVIDER=${driver.name} but ${(error as Error).message}`);
    }
    return driver.create(env);
  }
  const driver = drivers.find((candidate) => candidate.isConfigured(env));
  if (!driver) {
    throw new Error("No TYPESAFE_API_KEY, OPENROUTER_API_KEY (sk-or-), Cloudflare token (CLOUDFLARE_API_TOKEN or JEV_CLOUDFLARE_API_TOKEN) + CLOUDFLARE_ACCOUNT_ID, or AI_GATEWAY_API_KEY found. Set one, or JEV_PROVIDER to choose explicitly.");
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

export async function ask(input: JevTransportInput, config: AskConfig = {}): Promise<AskResult> {
  let transport: JevTransport;
  try {
    transport = config.transport ?? resolveTransport(config.env);
  } catch (error) {
    // Registry errors are fixed strings; never echo arbitrary driver exceptions.
    const message = error instanceof Error && /^(Unknown JEV_PROVIDER|No TYPESAFE_API_KEY|JEV_PROVIDER=)/.test(error.message)
      ? error.message : "Jev provider configuration failed";
    return { ok: false, code: "configuration_error", message };
  }
  // Injected transport names are untrusted and never included in error text.
  const provider = typeof transport.name === "string" && /^(typesafe|openrouter|cloudflare|vercel|fixture)$/.test(transport.name) ? transport.name : "unknown";
  let reply: JevTransportReply;
  try {
    reply = await transport.ask(input);
  } catch {
    return { ok: false, code: "request_failed", message: `Jev provider ${provider}: request failed` };
  }
  const fail = (id: string, code: RejectionCode, reason: string): AskResult => ({ ok: false, code, message: `Jev provider ${provider} question ${id}: ${reason}` });
  if (!record(input.questions)) return fail("<response>", "invalid_criteria", "questions must be an object");
  if (!record(reply) || !record(reply.answers)) return fail("<response>", "malformed_answer", "answers must be an object");
  const answers = reply.answers as Record<string, unknown>;
  const ids = Object.keys(input.questions);
  for (const id of ids) if (!Object.hasOwn(answers, id)) return fail(id, "answer_id_mismatch", "missing answer");
  if (Object.keys(answers).length !== ids.length) return fail("<response>", "answer_id_mismatch", "unexpected answer ID");
  const validated: [string, JevAnswer][] = [];
  for (const id of ids) {
    const question = input.questions[id];
    const answer = answers[id];
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
      if (typeof answer.score !== "number" || !Number.isInteger(answer.score) || !keys.includes(String(answer.score))) return fail(id, "invalid_choice", "score is outside criteria levels");
      validated.push([id, { type: "score", score: answer.score as number, probabilities, confidence: confidence as number | null }]);
    } else return fail(id, "malformed_answer", "unsupported question type");
  }
  if (!record(reply.usage) || !Number.isSafeInteger(reply.usage.input_tokens) || (reply.usage.input_tokens as number) < 0 || !Number.isSafeInteger(reply.usage.output_tokens) || (reply.usage.output_tokens as number) < 0) {
    return fail("<response>", "invalid_usage", "usage counters must be non-negative safe integers");
  }
  if (typeof reply.model !== "string" || !reply.model.trim()) return fail("<response>", "invalid_model", "effective model must be nonempty");
  return { ok: true, answer: Object.fromEntries(validated), usage: reply.usage as JevTransportReply["usage"], provider, model: reply.model as string };
}
