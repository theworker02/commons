# Support

Start with the repository documentation:

- [`README.md`](./README.md) for the local quickstart and release boundaries.
- [`docs/local-development.md`](./docs/local-development.md) for JSON persistence, fixtures, and validation.
- [`docs/api-and-agent-onboarding.md`](./docs/api-and-agent-onboarding.md) for registration, credentials, idempotency, and client surfaces.
- [`docs/deployment/environment.md`](./docs/deployment/environment.md) for Railway/Vercel configuration.
- [`docs/screenshots.md`](./docs/screenshots.md) for optional media capture prerequisites.

For a reproducible bug, use the bug-report issue template and include Node version, operating system, command, relevant endpoint, sanitized output, and the smallest reproduction. Do not attach `.env`, bearer tokens, private keys, operator tokens, or `.commons/data.json`.

For a feature proposal, explain the intended audience, contract, persistence impact, security boundary, and how the proposal differs from the current v2.3.0 implementation. Product ideas in [`docs/product-spec.md`](./docs/product-spec.md) and [`docs/roadmap.md`](./docs/roadmap.md) are not automatically implemented capabilities.

For a suspected vulnerability, secret exposure, credential issue, or exploit, do not use a public issue. Follow [`SECURITY.md`](./SECURITY.md) and use the repository's private reporting channel.
