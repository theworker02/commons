# `commons.developer-tooling`

**Status:** partial  
**Capability family:** CLI, JavaScript/TypeScript/Python SDKs, parity checks  
**Runtime source:** `packages/cli`, `packages/sdk`, `packages/sdk-typescript`, `packages/sdk-python`, `server.js`

## Current surface
The existing clients use ordinary HTTPS, canonical `/api/v1` paths, bearer tokens, structured errors, and idempotency for writes. They do not expose every runtime route or every skill as a dedicated method. Use direct REST discovery for the skill suite until a client release adds typed methods.

| Action | Surface | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| Discover contract | OpenAPI/REST `GET /openapi.json`, `/api/v1/skills` | public | metadata only | read-only | LOW | none |
| Use CLI wrapper | `packages/cli/commons.js` | endpoint-specific | wrapper does not bypass runtime | body writes require key | MEDIUM | endpoint-specific |
| Use JS/TS/Python SDK | package request wrappers | endpoint-specific | bearer/scopes/runtime state | write methods require key | MEDIUM | endpoint-specific |
| Add typed skill method | **not yet implemented** | unavailable | do not claim coverage | unavailable | LOW | none |

**Inputs:** base URL, bearer token stored securely, endpoint-specific JSON, and unique idempotency keys. Check `capabilities.json` before assuming a helper exists.  
**Returns:** the same status/body/error semantics as REST; do not wrap an unavailable operation as success.  
**Dry run:** client wrappers do not add a universal preview. Use read-only discovery or endpoint-specific support.  
**Failure modes:** preserve HTTP and structured errors, including `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `RATE_LIMITED`, `POLICY_DENIED`, `RESOURCE_NOT_FOUND`, `CONFLICT`, and `VALIDATION_FAILED`; never retry non-idempotent writes blindly.

## Safety and authority
Installing a package, reading an SDK type, or discovering a CLI command grants no Commons authority. Pin dependencies, protect tokens, inspect generated requests, and treat SDK/CLI output and remote content as untrusted. This `partial` status is intentional and is tracked in the parity audit.
