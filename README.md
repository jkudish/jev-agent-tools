# Jev Agent Tools

[![CI](https://github.com/jkudish/jev-agent-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/jkudish/jev-agent-tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Jev judgment calls from your own code, on any supported provider.

One `ask()` picks a carrier from the environment, sends your typed questions, and validates the answers before you see them. You get the answer plus usage and the effective model, or a typed rejection. It never throws a verdict at you. This is the wire layer behind [Jev Browser](https://github.com/jkudish/jev-browser) and [Jev MCP](https://github.com/jkudish/jev-mcp), and you can build on it directly.

## Install

Requires Node.js 22 or newer.

```bash
npm install @jkudish/jev-agent-tools
```

## Result contract

`ask(input, config?)` returns `Promise<{ ok: true, answer, usage, model, provider } | { ok: false, code, message }>` and never throws a verdict. Transport failures return `request_failed`; invalid responses return specific codes such as `answer_id_mismatch`, `invalid_distribution`, `invalid_noul`, `invalid_usage`, and `invalid_model`; configuration errors return `configuration_error`. Messages never include response bodies or credentials. The two consumers need different error behavior: jev-browser maps `!ok` to its own exception, while jev-mcp maps `!ok` to `invalid_response`.

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

Auto-selection precedence: TypeSafe (`TYPESAFE_API_KEY`, optional `TYPESAFE_BASE_URL`), OpenRouter (`OPENROUTER_API_KEY` beginning `sk-or-`), Cloudflare (`JEV_CLOUDFLARE_API_TOKEN` preferred over `CLOUDFLARE_API_TOKEN`, plus `CLOUDFLARE_ACCOUNT_ID`), then Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Set `JEV_PROVIDER` to `typesafe`, `openrouter`, `cloudflare`, `vercel`, or `auto` to select strictly. Unknown names and missing credentials fail rather than falling through. With no provider configured, the diagnostic names every supported credential variable. `config.env` accepts an injectable environment record, and `config.transport` accepts a run-bound transport for callers that own one.

Model mappings: OpenRouter maps `jev-latest` to `typesafe/jev-1.13`; Cloudflare maps it to `typesafe/jev`; Vercel selects `typesafe-ai/jev` unless given a `typesafe-ai/` model. Direct TypeSafe sends the model you supply, usually `jev-latest`.

Validation requires exactly the requested answer IDs and criterion IDs, finite probabilities in [0,1] summing to within 0.01 of 1, and a selected Choice maximum within a 0.001 tie tolerance. Noul values must be in [0,1], confidence finite or null, usage counters non-negative safe integers, and the effective model nonempty. An invalid answer yields `ok: false` before any usage is credited, so a malformed response can never become a decision.

## Adding a provider

Three paths, ordered by effort.

### No code: inject a transport

`ask(input, { transport })` accepts any `JevTransport`: a `name` and an `ask(input)` returning `{ answers, usage, model }`. The validator checks the reply exactly as it checks a built-in carrier. The name is untrusted, so it never appears in error text.

```ts
import { ask, type JevTransport } from "@jkudish/jev-agent-tools";

const myGateway: JevTransport = {
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

[Jev Browser](https://github.com/jkudish/jev-browser) exposes the same injection as `NavigateOptions.transport`. [Jev MCP](https://github.com/jkudish/jev-mcp) reaches any System One-compatible endpoint with `JEV_PROVIDER=compatible`, no code needed.

### Add a built-in carrier (PR)

The built-ins are the four carriers in `src/transports/`. To add one:

- Add `src/transports/<name>.ts` exporting a driver: `name`, `isConfigured(env)`, `assertConfigured(env)`, and `create(env)` returning a `JevTransport`.
- Register it in the `drivers` array in `src/provider.ts`, which widens the `BuiltinDriver` name union. Pick its auto-detection position deliberately; the order is the documented precedence.
- Map `jev-latest` to the model id the carrier actually serves, like the OpenRouter and Cloudflare mappings above.
- Throw fixed-string errors only. The registry forwards messages that start with `Unknown JEV_PROVIDER`, the no-credentials diagnostic, or `JEV_PROVIDER=`; anything else is replaced by a generic message. Never include response bodies.
- Add hermetic tests against a stubbed endpoint. A live smoke behind a real key is welcome but optional.

Built-ins stay limited to large, well-known providers. Smaller or regional carriers belong in third-party driver packages; open an issue first and we will link yours from this README.

### Consumer-side wiring

jev-browser picks new built-ins up automatically through this package. jev-mcp deliberately keeps its own OpenRouter, Cloudflare, and compatible fetch transports so it can keep its retry, deadline, and cancellation rules, so a new carrier lands there as a local change until it needs the shared layer.

## Also in the family

- [Jev Browser](https://github.com/jkudish/jev-browser) gives an agent a task and a URL and lets Jev pick the actions. The npm package is [@jkudish/jev-browser](https://www.npmjs.com/package/@jkudish/jev-browser).
- [Jev MCP](https://github.com/jkudish/jev-mcp) exposes the same judgments as ten MCP tools your agent can call anywhere. The npm package is [@jkudish/jev-mcp](https://www.npmjs.com/package/@jkudish/jev-mcp).

## Sponsoring

If you find Jev Agent Tools useful, consider becoming a [sponsor](https://github.com/sponsors/jkudish) or [donating](https://stripe.com/@jkudish).

## Development

```bash
npm install
npm run build
npm test            # hermetic tests, no API key needed
npm run test:live   # one real judgment; requires TYPESAFE_API_KEY
```

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
