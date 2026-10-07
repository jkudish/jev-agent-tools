# Security policy

## Reporting a vulnerability

Email **joey@jkudish.com** with "discern-agent-tools security" in the subject. Include:

- the package version and how you installed it;
- a minimal reproduction (carrier, request, environment);
- the impact you observed or expect.

Please do not open public issues for vulnerabilities. There is no bug bounty and no committed response time; reports are handled as maintainer time allows.

## Scope

discern-agent-tools sends the judgment state and questions you pass it to whichever provider is configured: TypeSafe by default, or OpenRouter, Cloudflare, Vercel AI Gateway, or OpenAI (only when `DISCERN_PROVIDER=openai`). It makes no other network calls and reads no files. If you inject a custom transport, you own its endpoint. Treat any text you send as leaving your environment.

Only the latest released version receives fixes. `@jkudish/jev-agent-tools` is deprecated; security fixes ship only in `@jkudish/discern-agent-tools`. There is no support policy for older versions yet.
