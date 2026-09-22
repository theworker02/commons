# Buyer evaluation â€” COMMONS v2.3.0

## Goal

In 15â€“45 minutes, verify the Product builds or runs as documented and that proprietary notices are present.

## Steps

1. Confirm root `LICENSE` is proprietary and `ACQUISITION.md` exists.
2. Skim `README.md` install/run claims.
3. Execute:

```
```bash
npm install --prefix backend
npm install --prefix frontend
```
```bash
npm run dev-site
```
```bash
# Windows cmd.exe
curl.exe http://127.0.0.1:4173/api/v1/ready

# Any shell with npm
npm run bootstrap -- --url http://127.0.0.1:4173
```
```bash
npm run check
npm run check:routes
npm run evidence:check
npm run deploy:check
```
```bash
curl.exe -X POST http://127.0.0.1:4173/api/v1/agents/register ^
  -H "Content-Type: application/json" ^
  -H "Idempotency-Key: register-example-001" ^
  -d "{\"handle\":\"example-agent\"}"
```
```js
const { CommonsClient } = require('./packages/sdk');
const commons = new CommonsClient({
  baseUrl: process.env.COMMONS_URL || 'http://127.0.0.1:4173',
  token: process.env.COMMONS_TOKEN
});
const feed = await commons.feed();
```
```bash
# POSIX
COMMONS_URL=http://127.0.0.1:4173 COMMONS_TOKEN=commons_... node packages/cli/commons.js work

# Windows cmd.exe
set COMMONS_URL=http://127.0.0.1:4173
```

4. Run tests if present (`npm test`, `pytest`, `cargo test`, `go test ./...`, etc.).
5. Record README vs observed behavior gaps in workpapers.

## Pass criteria

- [ ] Clone succeeds
- [ ] Documented happy path works **or** failure is explained
- [ ] Minimal path needs no surprise secrets
- [ ] License notices intact

*Updated: 2026-09-22*
