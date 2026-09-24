# @jkudish/jev-agent-tools

Shared Jev judgment wire layer for [jev-browser](https://github.com/jkudish/jev-browser) and [jev-mcp](https://github.com/jkudish/jev-mcp). This package only selects a carrier, sends a judgment, and validates its answer. It has no runtime dependencies, Playwright, MCP SDK, or AI SDK.

## Result contract

`ask(input, config?)` returns `Promise<{ ok: true, answer, usage, model, provider } | { ok: false, code, message }>` and never throws a verdict. Transport failures return `request_failed`; invalid responses return specific codes such as `answer_id_mismatch`, `invalid_distribution`, `invalid_noul`, `invalid_usage`, and `invalid_model`. Configuration errors use `configuration_error`. Messages do not include response bodies or credentials. The two consumers need different error behavior: jev-browser can map `!ok` to its own exception, while jev-mcp can map `!ok` to `invalid_response`.

```js
import { ask } from "@jkudish/jev-agent-tools";

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

Auto-selection precedence: TypeSafe (`TYPESAFE_API_KEY`, optional `TYPESAFE_BASE_URL`), OpenRouter (`OPENROUTER_API_KEY` beginning `sk-or-`), Cloudflare (`JEV_CLOUDFLARE_API_TOKEN` preferred over `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`), then Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Set `JEV_PROVIDER` to `typesafe`, `openrouter`, `cloudflare`, `vercel`, or `auto` to select strictly. Unknown names and missing credentials for forced providers fail rather than falling through. Without a provider, the diagnostic names every supported credential variable. `config.env` accepts an injectable environment record, and `config.transport` accepts a run-bound transport for callers that own one.

Models retain the browser driver's mappings: OpenRouter maps `jev-latest` to `typesafe/jev-1.13`; Cloudflare maps it to `typesafe/jev`; Vercel selects `typesafe-ai/jev` unless given a `typesafe-ai/` model. The direct TypeSafe driver sends the supplied model (usually `jev-latest`).

Validation requires exactly the requested answer IDs and criterion IDs, finite probabilities in [0,1] summing to within 0.01 of 1, and a selected Choice maximum within a 0.001 tie tolerance. Noul values must be in [0,1], confidence finite or null, usage counters non-negative safe integers, and the effective model nonempty. Invalid responses yield `ok: false` before any result usage is credited.
