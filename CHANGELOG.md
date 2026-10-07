# Changelog

## 1.0.0 (unreleased)

Renamed from `@jkudish/jev-agent-tools` to `@jkudish/discern-agent-tools`, because the package now carries Cloudflare's Clef and OpenAI's Decisions API alongside TypeSafe's Jev. See [Migrating from jev-agent-tools](README.md#migrating-from-jev-agent-tools).

### Rename

- Package `@jkudish/discern-agent-tools`. Types are `DiscernTransport`, `DiscernTransportInput`, `DiscernTransportReply`, and `DiscernAnswer`; the `Jev*` names stay as deprecated aliases until 2.0. `openrouterModel()` replaces `openrouterJevModel()`, which also stays as an alias.
- Environment variables are `DISCERN_*`. The listed legacy `JEV_*` names (the new `DISCERN_ENV_NAMES` export) keep working through 1.x; other `JEV_*` variables are ignored. A `JEV_`/`DISCERN_` pair with different values is a configuration error that names both variables and never their values. `normalizeDiscernEnv(env, names)` lets consumers alias their own variables.
- Error messages start with `Discern provider <name>`. Rejection codes are unchanged; match on `code`.

### New carriers and models

- OpenAI Decisions (public beta): `DISCERN_PROVIDER=openai` with `DISCERN_OPENAI_API_KEY` or `OPENAI_API_KEY`, optional `DISCERN_OPENAI_BASE_URL`. Never auto-detected. Nouls are sent as true/false choices carrying their criteria, state as labeled pretty-printed JSON, and requests over 200 questions are split into concurrent chunks.
- Cloudflare's Clef decision models on the Cloudflare carrier: model `clef` or `clef-flash`, or any `@cf/` id. New `cloudflareModel()` export.
- The `compatible` carrier for any System One endpoint (`DISCERN_API_KEY` and `DISCERN_API_BASE_URL`), moved from discern-mcp. It is auto-selected only when no other carrier is configured.
- The neutral model alias `latest` means each carrier's current default: Jev, or `gpt-6-luna` on OpenAI. `jev-latest` keeps working.

### One transport path

- Every carrier shares one HTTP path. It retries only 408, 409, 429, and 5xx, honoring `Retry-After`, and never re-sends after a network failure. `config.maxAttempts` (default 3) bounds attempts, and response bodies are capped at 1,000,000 bytes while they stream. OpenRouter, Cloudflare, and Vercel had no retries before.
- `ask()` enforces one deadline over every attempt: `config.timeoutMs`, default 60000, with the new rejection code `timeout`. Its timer and listener are released before it returns.
- `DISCERN_OPENROUTER_BASE_URL` and `DISCERN_CLOUDFLARE_BASE_URL` override those API roots. OpenRouter's token-limit failure reports `(HTTP 400, max_tokens_exceeded)`; no other upstream text reaches a message.
- Fixed messages from built-in carriers (an unparseable or oversized response, for example) appear in `request_failed`, even when a caller wraps a built-in transport. An injected transport's own messages never do.

### Validation

- A score must agree with its distribution: either the probability-weighted mean within two-decimal rounding, so it can fall between levels, or the most likely level. Live TypeSafe answers such as 1.65 were rejected before, and an integer score that matches neither is rejected now.
- New rejection code `refused` when a carrier declines a question. It fails the whole call.
- A malformed usage block is `invalid_usage` on every carrier, never `request_failed`.

### Other

- `config.onReply(reply)` observes the raw reply before validation, for callers that judge each answer on their own.
- An empty `DISCERN_PROVIDER` means `auto`. The OpenRouter attribution title is `discern`.

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
