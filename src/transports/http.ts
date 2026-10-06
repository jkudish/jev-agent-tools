// Shared POST-with-retry for the direct HTTP carriers (TypeSafe, OpenAI).
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

/**
 * POST a JSON body with up to three attempts and return the parsed reply.
 * Errors are fixed strings built from `label`; HTTP failures carry a numeric
 * `status` for the facade to classify. Response bodies never reach a message.
 */
export async function postJsonWithRetry(url: string, headers: Record<string, string>, body: string, signal: AbortSignal, label: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    let wire: Response;
    try {
      wire = await fetch(url, { method: "POST", headers, body, signal });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new Error(`${label} request failed`);
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
      throw Object.assign(new Error(`${label} HTTP ${wire.status} (response omitted)`), { status: wire.status });
    }
    try {
      return await wire.json();
    } catch {
      throw new Error(`${label} request failed`);
    }
  }
}
