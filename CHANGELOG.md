# Changelog

## 1.0.0 (unreleased)

Renamed from `@jkudish/jev-agent-tools` to `@jkudish/discern-agent-tools`. See the README's migration section.

- Rename: the package, the `Discern*` type names (`Jev*` kept as deprecated aliases), `DISCERN_*` environment variables, and `Discern provider` error messages. Legacy `JEV_*` variables keep working through 1.x; a `JEV_`/`DISCERN_` pair with different values is a configuration error. New `normalizeDiscernEnv()` export. An empty `DISCERN_PROVIDER` now means `auto`. OpenRouter attribution title is `discern`.
- OpenAI Decisions transport (public beta API): `DISCERN_PROVIDER=openai` with `DISCERN_OPENAI_API_KEY` or `OPENAI_API_KEY`, optional `DISCERN_OPENAI_BASE_URL`. Never auto-detected. `jev-latest` maps to `gpt-6-luna`. Nouls are sent as true/false choices carrying their criteria, state as labeled pretty-printed JSON, and requests above 200 questions are split into concurrent chunks.
- `openrouterModel()` replaces `openrouterJevModel()`, which stays as a deprecated alias.
- Score validation: a score must match its distribution, either as the probability-weighted mean (within two-decimal rounding) or as the most likely level. An integer score that is neither is now rejected.
- Score answers may be fractional. A non-integer score is accepted when it matches the probability-weighted mean of its distribution within two-decimal rounding; integer level scores are unchanged. Live TypeSafe score answers (for example 1.65) were previously rejected.
- Cloudflare's Clef decision models on the Cloudflare carrier: model `clef` or `clef-flash` (or any `@cf/` id). New `cloudflareModel()` export.
- One HTTP path for every carrier: retries on 408/409/429/5xx with `Retry-After`, never on network failures; `config.maxAttempts` (default 3) and a whole-request `config.timeoutMs` deadline (default 60000, new rejection code `timeout`); response bodies capped at 1,000,000 bytes while streaming. OpenRouter, Cloudflare, and Vercel previously had no retries.
- Carriers moved here from discern-mcp: the `compatible` System One endpoint (`DISCERN_API_KEY` + `DISCERN_API_BASE_URL`, auto-selected only when nothing else is configured), `DISCERN_OPENROUTER_BASE_URL`, `DISCERN_CLOUDFLARE_BASE_URL`, and OpenRouter's allow-listed `max_tokens_exceeded` error code.
- Neutral model alias `latest`: each carrier's current default model (Jev, or `gpt-6-luna` on OpenAI). `jev-latest` keeps working.
- A malformed usage block is now `invalid_usage` on every carrier, not `request_failed`. Fixed built-in error messages (for example an oversized or unparseable response) are kept in `request_failed` messages.
- `config.onReply(reply)`: observe the raw reply before validation without wrapping the transport, so built-in diagnostics are kept.
- `JEV_` aliasing covers only the variables in the new `DISCERN_ENV_NAMES` export; `normalizeDiscernEnv(env, names)` accepts a consumer's list.
- New rejection code `refused` when a carrier declines to answer a question.
- TypeSafe and OpenAI share one retry helper; TypeSafe behavior is unchanged.

## 0.2.0

- OpenRouter: `jev-latest` uses OpenRouter's `~typesafe/jev-latest` alias, an explicit alias is no longer double-prefixed, and results report the returned snapshot. Explicit version pins are unchanged. Reported in [jev-mcp#55](https://github.com/jkudish/jev-mcp/issues/55).
- Vercel transport: opt-in Gateway zero data retention routing with `JEV_VERCEL_ZERO_DATA_RETENTION=1` or `true`. Invalid values fail before a request is sent. Via [#7](https://github.com/jkudish/jev-agent-tools/pull/7), contributed by [@lloydsilvertwo](https://github.com/lloydsilvertwo).

## 0.1.4

- TypeSafe transport resilience: 408/409/429/5xx now retry (up to three attempts) honoring `Retry-After` — delay-seconds or HTTP-date, capped at 5s per sleep, abort-aware. Exhausted 429s classify as `rate_limited` and 5xx as `unavailable`; `request_failed` messages carry the numeric status, never the response body. The transport reports the API's effective model (`response.model`) instead of the requested alias, falling back only when the field is absent so malformed values surface through validation. Via [#6](https://github.com/jkudish/jev-agent-tools/pull/6), fixing [#5](https://github.com/jkudish/jev-agent-tools/issues/5), reported by [@deadczarvc](https://github.com/deadczarvc).

## 0.1.3

- Valid Jev answers with several weighted options are no longer rejected for rounding drift in their probability sum. The sum tolerance now scales with the number of nonzero options (0.5% each, capped at 5%) with a 1% floor, plus a float-safe epsilon, so two-decimal provider rounding like 1.01 over 60 options passes while garbage sums still fail. Via [#3](https://github.com/jkudish/jev-agent-tools/pull/3), found diagnosing [jev-browser#19](https://github.com/jkudish/jev-browser/pull/19) e2e.

## 0.1.2

- Docs: README rewrite with badges, install, and governance links; CONTRIBUTING and SECURITY policies; package description updated.
- Docs: per-provider reference bullets, split Validation section, and provider policy: built-ins for major providers, third-party driver packages for the rest, linked from the sibling READMEs on request.

## 0.1.0

- Extract four run-bound Jev judgment carriers and strict provider selection from jev-browser.
- Return validated answers or typed rejections through a non-throwing Result API, with hermetic tests and optional live TypeSafe smoke.
