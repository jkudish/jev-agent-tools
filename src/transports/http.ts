// The one HTTP path for every built-in carrier: bounded retries, a streamed
// response-size ceiling, and fixed-string errors. The whole-request deadline
// lives in ask(), which hands every transport a single signal covering all
// attempts.
//
// Retry policy: only the not-processed status allowlist (408, 409, 429,
// 500-599) is retried. Network-level failures never are: without an
// idempotency key, re-sending after an ambiguous failure can double-process
// a paid call. Caller aborts and deadline expiry cut any backoff short and
// never retry. Research and the original report: jkudish/jev-mcp#23 by oppih.

export const DEFAULT_MAX_ATTEMPTS = 3;
/** Total attempts per request, including the first, clamped to 1..6. */
export const clampAttempts = (n: number | undefined): number =>
  Number.isInteger(n) ? Math.min(6, Math.max(1, n as number)) : DEFAULT_MAX_ATTEMPTS;
/** Stream-checked ceiling for success and error bodies alike. */
export const MAX_RESPONSE_BYTES = 1_000_000;
// One Retry-After hint never sleeps longer than this between attempts.
const MAX_DELAY_MS = 5_000;

const retryable = (status: number) => status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);

const backoffMs = (retryAfter: string | null, attempt: number): number => {
  // Retry-After as delay-seconds or HTTP-date; a past date means retry now.
  if (retryAfter) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), MAX_DELAY_MS);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_DELAY_MS);
  }
  // No usable header: jittered exponential backoff, 50-100% of the doubling delay.
  const ceiling = Math.min(500 * 2 ** (attempt - 1), 4_000);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
};

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  if (ms <= 0) return resolve();
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

/** An HTTP failure: a fixed message, the numeric status, and optionally an allow-listed detail code. Never a response body. */
export class CarrierHttpError extends Error {
  constructor(label: string, readonly status: number, readonly detail?: string) {
    super(`${label} HTTP ${status}${detail ? ` (${detail})` : ""} (response omitted)`);
  }
}

/** Read a body with the byte ceiling enforced on the bytes actually streamed (Content-Length is advisory). */
async function readBounded(response: Response, signal: AbortSignal, label: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error(`${label} response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof Error && error.message.startsWith(`${label} response exceeded`)) throw error;
    throw new Error(`${label} request failed`);
  } finally {
    // Releases the connection when the read stopped early.
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface PostOptions {
  /** Fixed carrier label used in every error message. */
  label: string;
  signal: AbortSignal;
  maxAttempts?: number;
  /** Maps a final error body to an allow-listed detail code; must never return upstream text. */
  errorDetail?: (body: string) => string | undefined;
}

/** POST a JSON body and return the parsed reply. Errors are fixed strings; HTTP failures are CarrierHttpError. */
export async function postJson(url: string, headers: Record<string, string>, body: string, options: PostOptions): Promise<unknown> {
  const { label, signal } = options;
  const attempts = clampAttempts(options.maxAttempts);
  for (let attempt = 1; ; attempt++) {
    let wire: Response;
    try {
      wire = await fetch(url, { method: "POST", headers, body, signal });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new Error(`${label} request failed`); // network failure: never re-sent
    }
    if (retryable(wire.status) && attempt < attempts) {
      // Fire-and-forget the connection release; awaiting a stream
      // cancellation that never settles would stall past the caller's abort.
      void wire.body?.cancel().catch(() => {});
      await sleep(backoffMs(wire.headers.get("retry-after"), attempt), signal);
      continue;
    }
    const text = await readBounded(wire, signal, label);
    if (!wire.ok) {
      let detail: string | undefined;
      try {
        detail = options.errorDetail?.(text);
      } catch {
        detail = undefined;
      }
      throw new CarrierHttpError(label, wire.status, detail && /^[a-z0-9_]{1,64}$/.test(detail) ? detail : undefined);
    }
    try {
      return JSON.parse(text);
    } catch {
      // JSON.parse errors quote their input; a reflecting endpoint must not leak through them.
      throw new Error(`${label} returned an unparseable response`);
    }
  }
}

/** Appends a path to a configured API root; a trailing slash on the root never produces "//path". */
export const apiUrl = (root: string, path: string) => `${root.replace(/\/+$/, "")}${path}`;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Normalize a reply's usage block: absent means zero, anything else passes
 * through so the shared validator reports invalid_usage instead of a transport
 * failing with request_failed.
 */
export function usageOf(value: unknown): { input_tokens: number; output_tokens: number } {
  if (value === undefined) return { input_tokens: 0, output_tokens: 0 };
  if (!record(value)) return value as never;
  return {
    input_tokens: Object.hasOwn(value, "input_tokens") ? value.input_tokens as number : 0,
    output_tokens: Object.hasOwn(value, "output_tokens") ? value.output_tokens as number : 0,
  };
}
