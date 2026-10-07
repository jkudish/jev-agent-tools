# Discern Agent Tools

[![CI](https://github.com/jkudish/discern-agent-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/jkudish/discern-agent-tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src=".github/discern-agent-tools-banner.png" alt="discern-agent-tools — One validated ask() across judgment providers. Runs on TypeSafe's Jev, Cloudflare's Clef, or OpenAI Decisions." />
</p>

Multi-provider judgment transport with fail-closed validation, used by [Discern Browser](https://github.com/jkudish/discern-browser) and [Discern MCP](https://github.com/jkudish/discern-mcp). It sends typed questions to TypeSafe's Jev model (directly or through OpenRouter, Cloudflare, or Vercel) or to OpenAI's Decisions API.

Formerly `@jkudish/jev-agent-tools`; see [Migrating from jev-agent-tools](#migrating-from-jev-agent-tools).

One `ask()` picks a carrier from the environment, sends your typed questions, and validates the answers before you see them. You get the answer plus usage and the effective model, or a typed rejection. It never throws a verdict at you. You can also build on it directly.

## Install

Requires Node.js 22 or newer.

```bash
npm install @jkudish/discern-agent-tools
```

## Result contract

`ask(input, config?)` returns `Promise<{ ok: true, answer, usage, model, provider } | { ok: false, code, message }>` and never throws a verdict. The TypeSafe transport retries 408/409/429/5xx up to three attempts, honoring `Retry-After` within the caller's abort signal. Transport failures return `request_failed` (message includes the HTTP status when there is one), `rate_limited` when 429 retries are exhausted, or `unavailable` when 5xx retries are exhausted, and report the API's effective model rather than the requested alias; invalid responses return specific codes such as `refused` (the carrier declined a question), `answer_id_mismatch`, `invalid_distribution`, `invalid_noul`, `invalid_usage`, and `invalid_model`; configuration errors return `configuration_error`. Messages never include response bodies or credentials. The two consumers need different error behavior: discern-browser maps `!ok` to its own exception, while discern-mcp maps `!ok` to `invalid_response`.

```js
import { ask } from "@jkudish/discern-agent-tools";

const result = await ask({
  state: "A customer asks for a refund of a duplicate charge.",
  questions: { refund: { type: "noul", instructions: "Is a refund requested?" } },
  model: "jev-latest",
  signal: new AbortController().signal,
});

if (!result.ok) console.error(result.code, result.message);
else console.log(result.answer.refund.noul, result.usage, result.model);
```

## Providers

Auto-selection tries them in this order:

- **TypeSafe** (`TYPESAFE_API_KEY`, optional `TYPESAFE_BASE_URL`): direct; sends the model you supply, usually `jev-latest`.
- **OpenRouter** (`OPENROUTER_API_KEY`, begins `sk-or-`): maps `jev-latest` to OpenRouter's moving `~typesafe/jev-latest` alias. Pin a version, such as `typesafe/jev-1.13`, for reproducible routing. Results report the snapshot OpenRouter returns.
- **Cloudflare** (`DISCERN_CLOUDFLARE_API_TOKEN` preferred over `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`): maps `jev-latest` to `typesafe/jev`.
  - The same carrier runs Cloudflare's own [Clef decision models](https://blog.cloudflare.com/clef-decision-models/): pass `clef` or `clef-flash` as the model (mapped to `@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`), or any `@cf/` model id unchanged. Clef uses the same request and answer format as Jev, so nothing is translated.
  - Clef is not Jev. It is a different model with its own calibration, so thresholds tuned on Jev need re-checking. `clef-flash` is the low-latency variant; expect occasional multi-second cold starts.
  - The token needs Workers AI access (Account → Workers AI → Read).
- **Vercel AI Gateway** (`AI_GATEWAY_API_KEY`, optional `DISCERN_VERCEL_ZERO_DATA_RETENTION`): selects `typesafe-ai/jev` unless given a `typesafe-ai/` model.
  - Set `DISCERN_VERCEL_ZERO_DATA_RETENTION=1` or `true` to request [Vercel's zero data retention (ZDR) routing](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr) on every request.
  - Unset, empty, `0`, or `false` leaves the request body unchanged. Any other value is a configuration error before a request is sent.
  - Use `DISCERN_PROVIDER=vercel` when every judgment must use this restriction; auto-selection prefers other configured carriers, which ignore the setting.
  - Vercel offers per-request ZDR on Pro and Enterprise plans. It filters Gateway routes, including fallbacks, under Vercel and provider policies; review [the listed provider terms and exceptions](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr#zdr-providers-and-policies). It does not control your application, MCP client, logs, browser artifacts, or other model providers.
- **OpenAI Decisions** (explicit only: `DISCERN_PROVIDER=openai`, with `DISCERN_OPENAI_API_KEY` preferred over `OPENAI_API_KEY`, optional `DISCERN_OPENAI_BASE_URL`): sends questions to [OpenAI's Decisions API](https://developers.openai.com/api/docs/guides/decisions) and maps `jev-latest` to `gpt-6-luna`.
  - This is not Jev. It is a different model with its own calibration, so thresholds tuned on Jev need re-checking against your own labeled examples.
  - It is never auto-detected, because `OPENAI_API_KEY` is common in environments that never chose it.
  - Each noul is sent as a two-option choice over `true` and `false`, with its criteria as option descriptions; the noul is the weight on `true`. State is sent pretty-printed under a `State (JSON):` label, which costs about 35% more input tokens than compact JSON but agreed with Jev more often on captured requests. Limits: 255 choices, 10 score levels; requests above 200 questions are split into concurrent chunks.
  - The API is in public beta and may change before GA.

Set `DISCERN_PROVIDER` to `typesafe`, `openrouter`, `cloudflare`, `vercel`, `openai`, or `auto` to select strictly. Unknown names and missing credentials fail rather than falling through; an empty value means `auto`. With no provider configured, the diagnostic names every supported credential variable. `config.env` accepts an injectable environment record, and `config.transport` accepts a run-bound transport for callers that own one.

## Validation

Every reply is checked before you see it. Validation requires exactly the requested answer IDs and criterion IDs, finite probabilities in [0,1] summing to within 0.01 of 1, and a selected Choice maximum within a 0.001 tie tolerance. Score answers must be an integer level or, when fractional, the probability-weighted mean of their distribution within two-decimal rounding. Noul values must be in [0,1], confidence finite or null, usage counters non-negative safe integers, and the effective model nonempty. An invalid answer yields `ok: false` before any usage is credited, so a malformed response can never become a decision.

## Adding a provider

The built-in list is a fixed, maintainer-curated set, currently: TypeSafe, OpenRouter, Cloudflare, Vercel, and OpenAI (explicit only). PRs that add a new built-in carrier are generally not accepted unless sufficient demand is shown. If you want support for a new provider, the supported path is a third-party driver package. I will accept PRs that link third-party providers from the READMEs of this package, [discern-browser](https://github.com/jkudish/discern-browser), and [discern-mcp](https://github.com/jkudish/discern-mcp).

### No code: inject a transport

`ask(input, { transport })` accepts any `DiscernTransport`: a `name` and an `ask(input)` returning `{ answers, usage, model }`. The validator checks the reply exactly as it checks a built-in carrier. The name is untrusted, so it never appears in error text.

```ts
import { ask, type DiscernTransport } from "@jkudish/discern-agent-tools";

const myGateway: DiscernTransport = {
  name: "my-gateway",
  async ask({ state, questions, model, signal }) {
    const response = await fetch("https://gw.example.com/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.MY_GATEWAY_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model, state, questions }),
      signal,
    });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const body = await response.json();
    return {
      answers: body.answers,
      usage: { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens },
      model: body.model,
    };
  },
};

const result = await ask(input, { transport: myGateway });
```

[Discern Browser](https://github.com/jkudish/discern-browser) exposes the same injection as `NavigateOptions.transport`. [Discern MCP](https://github.com/jkudish/discern-mcp) reaches any System One-compatible endpoint with `DISCERN_PROVIDER=compatible`, no code needed.

### Publish a third-party driver package

Wrap your carrier in a small npm package that exports a factory, so callers keep their credentials in their own environment:

```ts
import { ask } from "@jkudish/discern-agent-tools";
import { createRequestyTransport } from "@example/requesty-discern-driver";

const result = await ask(input, { transport: createRequestyTransport(process.env) });
```

A driver package exports a factory that returns a `DiscernTransport`: a `name`, and an `ask` that returns `{ answers, usage, model }`. Document the credential environment variables it reads, map `jev-latest` to the model id your carrier serves, and keep error messages free of response bodies and credentials. Validation still happens here, so a malformed reply from your carrier can never become a decision.

Published a driver package? Open an issue or pull request on any of the three repositories and it will be linked from that README's provider section.

### Adding a built-in carrier

The built-ins are a fixed, maintainer-curated set (TypeSafe, OpenRouter, Cloudflare, Vercel, OpenAI). New built-ins are generally not accepted unless sufficient demand is shown — open an issue first. The mechanics, for when one is accepted:

- Add `src/transports/<name>.ts` exporting a driver: `name`, `isConfigured(env)`, `assertConfigured(env)`, and `create(env)` returning a `DiscernTransport`.
- Register it in the `drivers` array in `src/provider.ts`, which widens the `BuiltinDriver` name union. Pick its auto-detection position deliberately; the order is the documented precedence.
- Map `jev-latest` to the model id the carrier actually serves, like the OpenRouter and Cloudflare mappings above.
- Throw fixed-string errors only. The registry forwards messages that start with `Unknown DISCERN_PROVIDER`, the no-credentials diagnostic, or `DISCERN_PROVIDER=`; anything else is replaced by a generic message. Never include response bodies.
- Add hermetic tests against a stubbed endpoint. A live smoke behind a real key is welcome but optional.

### Consumer-side wiring

discern-browser picks new built-ins up automatically through this package. discern-mcp deliberately keeps its own OpenRouter, Cloudflare, and compatible fetch transports so it can keep its retry, deadline, and cancellation rules, so a new carrier lands there as a local change until it needs the shared layer.

## Also in the family

- [Discern Browser](https://github.com/jkudish/discern-browser) gives an agent a task and a URL and lets the judgment model pick the actions. The npm package is [@jkudish/discern-browser](https://www.npmjs.com/package/@jkudish/discern-browser).
- [Discern MCP](https://github.com/jkudish/discern-mcp) exposes the same judgments as MCP tools your agent can call anywhere. The npm package is [@jkudish/discern-mcp](https://www.npmjs.com/package/@jkudish/discern-mcp).

## Migrating from jev-agent-tools

1.0.0 renames the package; behavior is unchanged apart from the OpenAI carrier and the fractional-score fix listed in the [changelog](CHANGELOG.md).

- Install `@jkudish/discern-agent-tools` and update imports. `@jkudish/jev-agent-tools` is deprecated and receives no further releases.
- Rename environment variables from `JEV_<X>` to `DISCERN_<X>`. Through 1.x the old names still work: a `JEV_` value is used when its `DISCERN_` counterpart is unset or empty, and two different non-empty values are a configuration error that names both variables. `JEV_` names stop working in 2.0.

  | Before | After |
  | --- | --- |
  | `JEV_PROVIDER` | `DISCERN_PROVIDER` |
  | `JEV_CLOUDFLARE_API_TOKEN` | `DISCERN_CLOUDFLARE_API_TOKEN` |
  | `JEV_VERCEL_ZERO_DATA_RETENTION` | `DISCERN_VERCEL_ZERO_DATA_RETENTION` |

- Rename types: `JevTransport`, `JevTransportInput`, `JevTransportReply`, and `JevAnswer` become `DiscernTransport`, `DiscernTransportInput`, `DiscernTransportReply`, and `DiscernAnswer`. The old names remain as deprecated aliases until 2.0.
- Error messages say `Discern provider <name>` instead of `Jev provider <name>`. Match on `code`, which is unchanged, rather than on message text.
- `normalizeDiscernEnv(env)` is exported for applications that read their own `DISCERN_` variables: it returns the environment with legacy values copied and the list of legacy names used, so you can print a deprecation warning.

Model names are unchanged: `jev-latest` and pinned versions such as `jev-1.13` still name TypeSafe's Jev model.

## Sponsoring

If you find Discern Agent Tools useful, consider becoming a [sponsor](https://github.com/sponsors/jkudish) or [donating](https://stripe.com/@jkudish).

## Development

```bash
npm install
npm run build
npm test            # hermetic tests, no API key needed
npm run test:live   # one real judgment per configured carrier; TYPESAFE_API_KEY and/or OPENAI_API_KEY
```

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
