# Contributing

Thanks for considering a contribution. This is a small package with a narrow scope: pick a carrier, send one judgment request, validate the answer. The consumers (jev-browser, jev-mcp) own everything above the wire.

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
npm run test:live   # one real TypeSafe judgment, requires TYPESAFE_API_KEY
```

The hermetic suite stubs every endpoint and runs everywhere, including CI. The live smoke runs only when a `TYPESAFE_API_KEY` is configured. Both must pass before a pull request can merge. If you add behavior, add the test that would have caught its absence.

## Pull requests

- Keep changes small and scoped to one carrier or one validation rule.
- New carriers follow the [add-a-provider guide](README.md#adding-a-provider). Open an issue first so we can agree on whether it belongs in the built-ins; smaller carriers are better as third-party driver packages we link from the README.
- Error messages are fixed strings. Never include response bodies or credentials.
- Keep `ask()` non-throwing. Rejections are typed results.

## Notes

- Validation tolerances (sum drift, tie tolerance) are deliberate and documented in the README. Change them only with a failing case as evidence.
