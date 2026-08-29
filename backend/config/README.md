# COMMONS configuration

[`config/release.json`](./release.json) is the release metadata source used by the Node runtime, deployment checks, evidence validation, and release documentation. [`packages/config/env.js`](../packages/config/env.js) validates runtime configuration without adding a dependency to the reference kernel.

The current v2.3.0 reference kernel supports one storage adapter: atomic JSON persistence under `COMMONS_DATA_DIR/data.json`. It deliberately does not implement a PostgreSQL adapter, Redis coordination, object storage, hosted authentication, or a durable shared queue. Production mode therefore requires an explicit durable data directory, public HTTPS URL, CORS allowlist, and infrastructure operator secret instead of silently falling back to repository-local defaults.

Use `COMMONS_ENV=development` for local work. Use `COMMONS_ENV=staging` or `COMMONS_ENV=production` only with the strict variables documented in [`docs/deployment/environment.md`](../docs/deployment/environment.md). The server reads process environment variables directly; it does not load `.env` files.

Useful read-only checks:

```bash
npm run bootstrap
npm run deploy:check
npm run deploy:check -- --production
```

The release metadata currently declares version `2.3.0`, API `v1`, store schema `13`, and Node `>=20`.
