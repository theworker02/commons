# @theworker02/commons-api

The COMMONS API contract as an installable package: the OpenAPI document, the
canonical route inventory, the credential scope vocabulary, the error code
catalogue, and the discovery documents.

Zero dependencies. No runtime behaviour — this package *describes* the API, it
does not call it. For a client that performs requests, use the SDK.

```
npm install @theworker02/commons-api
```

## Why this exists

A client needs three things the API alone does not hand you conveniently: the
full set of scopes it can request, the stable error codes it should switch on,
and the complete route surface including the parts that were never written into
OpenAPI. Copying those into each consumer is how they drift.

Everything in `generated/` is derived from the implementation at build time, and
the build fails if the package version disagrees with
`backend/config/release.json`. A published version therefore cannot describe an
API revision it did not ship alongside.

Sources, in order of authority:

| Generated file | Derived from |
| --- | --- |
| `openapi.json` | `backend/openapi.json` |
| `release.json` | `backend/config/release.json` |
| `scopes.json` | `backend/server.js` (read statically) |
| `errors.json` | `backend/server.js` (every `httpError` call site) |
| `routes.json` | `artifacts/routes-legacy.json` |
| `storage.json` | `config/cloudflare-parity.json` |
| `well-known.json` | `.well-known/*` |

`server.js` is parsed, never imported: importing it validates the environment and
starts a listener.

## Install from GitHub Packages

This package is published to GitHub Packages, not the public npm registry.
Point the `@theworker02` scope at GitHub in `.npmrc`:

```ini
@theworker02:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs the `read:packages` scope. Never commit the token — use an
environment variable, as above.

In GitHub Actions, `secrets.GITHUB_TOKEN` already carries `read:packages` for
repositories in the same account.

## Usage

```js
import {
  VERSION,
  ALL_SCOPES,
  isWriteScope,
  partitionScopes,
  statusesForErrorCode,
  listRoutes,
  storageStatusFor,
  discoveryUrls,
} from '@theworker02/commons-api';

VERSION;                       // '2.3.0'
ALL_SCOPES.length;             // 38

// Validate a scope request locally instead of learning about it from a 400.
partitionScopes('posts:write bogus:scope');
// { known: ['posts:write'], unknown: ['bogus:scope'] }

isWriteScope('posts:write');   // true  -> needs an Idempotency-Key
statusesForErrorCode('not_found'); // [404]

// The whole OAuth surface.
listRoutes({ domain: 'oauth' }).length;   // 14

// Only the routes that are actually documented in OpenAPI.
listRoutes({ documented: true }).length;  // 149
```

### One origin, one base URL

The API serves everything from a single origin — REST, MCP, OAuth and
`.well-known` alike — so a client only ever needs one URL:

```js
const urls = discoveryUrls('https://commons-production.example.workers.dev');
urls.mcp;       // .../mcp
urls.openapi;   // .../openapi.json
urls.ready;     // .../api/v1/ready
```

### Storage posture

The API is mid-migration onto Cloudflare. Some domains have first-class D1
tables; the long tail is still on a transitional compatibility table. That is
published rather than hidden, because it tells you whether a domain's physical
schema is still expected to change:

```js
storageStatusFor('social');   // 'normalized'
storageStatusFor('articles'); // 'compat-record-backed'
storageStatusFor('contracts');// 'stateless'
```

Behaviour and authorization are preserved for every domain either way. See
`docs/cloudflare/parity-ledger.md` in the repository for the full ledger.

## Subpath exports

Import the raw documents directly if you would rather not pull in the helpers:

```js
import openapi from '@theworker02/commons-api/openapi.json' with { type: 'json' };
import scopes  from '@theworker02/commons-api/scopes.json'  with { type: 'json' };
```

## Contract stability

- The package version tracks the API version exactly. `2.3.0` describes API
  `v1` at release `2.3.0`.
- Scope names, error codes and documented route shapes are stable within a major
  version.
- Anything reported as `compat-record-backed` in `storage.json` has stable
  *behaviour* but an unstable *physical schema*. That distinction only matters if
  you are reading the database directly, which you should not be.

## Development

```sh
npm run build --prefix packages/api    # regenerate generated/
npm run check --prefix packages/api    # fail if generated/ is stale
```

`npm run api:check` runs the staleness gate from the repository root, and CI runs
it on every push, so a change to the OpenAPI document or the scope list cannot
land without the package being rebuilt.

## Licence

MIT. See `LICENSE`.
