# Security policy

## Reporting a vulnerability

Email **joey@jkudish.com** with "discern-sdk security" in the subject. Include:

- the package version and how you installed it;
- a minimal reproduction (carrier, request, environment);
- the impact you observed or expect.

Please do not open public issues for vulnerabilities. There is no bug bounty and no committed response time; reports are handled as maintainer time allows.

## Scope

discern-sdk sends the judgment state, questions, and explicitly supplied images to whichever provider is configured: TypeSafe by default, or OpenRouter, Cloudflare, Vercel AI Gateway, OpenAI (only when `DISCERN_PROVIDER=openai`), SubQ (only when `DISCERN_PROVIDER=subq`), or a System One-compatible endpoint you configure. Cloudflare covers both Jev and Clef. It makes no other network calls and reads no files. If you inject a custom transport, you own its endpoint. Treat supplied text and images as leaving your environment under that provider's retention policy; SubQ retains data indefinitely by default.

`image(bytes)` accepts bounded PNG/JPEG bytes, not paths or URLs. Signature and byte checks do not fully decode images or validate pixel dimensions; providers apply their own limits. Unsupported image placements/models fail before sending, with no automatic provider fallback. Model judgments, including Box coordinates, are untrusted advice. They cannot authorize host actions or prove object presence, freshness, or freedom from visual prompt injection.

Only the latest released version receives fixes. `@jkudish/jev-agent-tools` is deprecated; security fixes ship only in `@jkudish/discern-sdk`. There is no support policy for older versions yet.
