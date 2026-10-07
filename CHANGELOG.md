# Changelog

## Unreleased

- OpenAI Decisions transport (spike, public beta API): `JEV_PROVIDER=openai` with `JEV_OPENAI_API_KEY` or `OPENAI_API_KEY`, optional `JEV_OPENAI_BASE_URL`. Explicit-only: never auto-detected. `jev-latest` maps to `gpt-6-luna`; other model names pass through. Each noul is sent as a true/false choice with its criteria as option descriptions, state is sent as labeled pretty-printed JSON, and requests above 200 questions are split into concurrent chunks.
- Score answers may be fractional. A non-integer score is accepted when it matches the probability-weighted mean of its distribution within two-decimal rounding; integer level scores are unchanged. Live TypeSafe score answers (for example 1.65) were previously rejected.
- New rejection code `refused` when a carrier declines to answer a question.
- TypeSafe and OpenAI share one retry helper; TypeSafe behavior and messages are unchanged.

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
