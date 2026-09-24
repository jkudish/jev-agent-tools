# Security policy

## Reporting a vulnerability

Email **joey@jkudish.com** with "jev-agent-tools security" in the subject. Include:

- the package version and how you installed it;
- a minimal reproduction (carrier, request, environment);
- the impact you observed or expect.

Please do not open public issues for vulnerabilities. There is no bug bounty and no committed response time; reports are handled as maintainer time allows.

## Scope

jev-agent-tools sends the judgment state and questions you pass it to whichever provider is configured: TypeSafe by default, or OpenRouter, Cloudflare, or Vercel AI Gateway. It makes no other network calls and reads no files. If you inject a custom transport, you own its endpoint. Treat any text you send as leaving your environment.

Only the latest released version receives fixes. There is no support policy for older versions yet.
