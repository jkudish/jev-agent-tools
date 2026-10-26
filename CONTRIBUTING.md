# Contributing

Thanks for considering a contribution. This is a small package with a narrow scope: pick a carrier, send one judgment request, validate the answer. The consumers (discern-browser, discern-mcp) own everything above the wire.

## Development

```bash
npm install
npm run build
npm run typecheck
```

Node.js 22 or newer. TypeScript, ESM; no runtime dependencies.

## Tests

```bash
npm test            # hermetic tests, offline
npm run test:live   # one real judgment per configured carrier: TYPESAFE_API_KEY, OPENAI_API_KEY, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```

The hermetic suite stubs every endpoint and runs everywhere, including CI. Each live smoke runs only when its key is configured. Both must pass before a pull request can merge. If you add behavior, add the test that would have caught its absence.

## Pull requests

- Keep changes small and scoped to one carrier or one validation rule.
- New carriers follow the [add-a-provider guide](README.md#adding-a-provider). Open an issue first so we can agree on whether it belongs in the built-ins; smaller carriers are better as third-party driver packages we link from the README.
- Send requests through `postJson` in `src/transports/http.ts` so every carrier shares the retry, size, and error rules. Throw `CarrierFailure` with fixed strings; never include response bodies or credentials.
- Keep `ask()` non-throwing. Rejections are typed results.
- New environment variables use the `DISCERN_` prefix and go in `DISCERN_ENV_NAMES` (`src/env.ts`). Read them after `normalizeDiscernEnv`, never `process.env.JEV_*` directly; legacy `JEV_` names are aliases until 2.0.

## Notes

- Validation tolerances (sum drift, tie tolerance) are deliberate and documented in the README. Change them only with a failing case as evidence.
