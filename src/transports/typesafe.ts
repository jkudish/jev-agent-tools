import type { BuiltinDriver } from "../provider.js";

// Retriable statuses mirror the shared resilience policy: request timeout,
// conflict, rate limit, and server errors. Other statuses surface at once.
const RETRYABLE_STATUSES = new Set([408, 409, 429]);
const retryable = (status: number) => RETRYABLE_STATUSES.has(status) || status >= 500;
const MAX_ATTEMPTS = 3;
// One Retry-After hint never sleeps longer than this between attempts.
const MAX_DELAY_MS = 5_000;

const backoffMs = (retryAfter: string | null, attempt: number): number => {
  // Retry-After as delay-seconds or HTTP-date; a past date means retry now.
  let parsed = false;
  let ms = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds)) {
      ms = seconds * 1000;
      parsed = true;
    } else {
      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) {
        ms = at - Date.now();
        parsed = true;
      }
    }
  }
  // No usable header: small jittered exponential backoff.
  if (!parsed) ms = 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
  return Math.min(Math.max(ms, 0), MAX_DELAY_MS);
};

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (ms <= 0 || signal.aborted) {
    if (signal.aborted) reject(signal.reason);
    else resolve();
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});

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
        const body = JSON.stringify({ state, questions, model });
        let response: { answers: unknown; usage?: { input_tokens?: number; output_tokens?: number }; model?: unknown };
        for (let attempt = 1; ; attempt++) {
          let wire: Response;
          try {
            wire = await fetch(url, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
              body,
              signal,
            });
          } catch {
            if (signal.aborted) throw signal.reason;
            throw new Error("TypeSafe API request failed");
          }
          if (retryable(wire.status) && attempt < MAX_ATTEMPTS) {
            // Fire-and-forget the connection release; awaiting a stream
            // cancellation that never settles would stall past the caller's
            // abort. Backoff itself is abort-aware.
            void wire.body?.cancel().catch(() => {});
            await sleep(backoffMs(wire.headers.get("retry-after"), attempt), signal);
            continue;
          }
          if (!wire.ok) {
            // Numeric status only; the response body never reaches the message.
            throw Object.assign(new Error(`TypeSafe API HTTP ${wire.status} (response omitted)`), { status: wire.status });
          }
          try {
            response = await wire.json();
          } catch {
            throw new Error("TypeSafe API request failed");
          }
          break;
        }
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
