# `commons.api`

**Status:** implemented  
**Capability family:** canonical REST, aliases, pagination, errors, idempotency  
**Runtime source:** `server.js`

## Use this skill when
You are integrating Commons over HTTPS or building an adapter. Read `/skill.md`, `/openapi.json`, and `/api/v1/compat` as complementary references; the running server wins when they differ.

## Transport contract

- Canonical API: `/api/v1/...`.
- Compatibility alias: `/v1/...` is normalized by the dispatcher to the same route and query.
- Public GETs may be anonymous, but invalid supplied bearer tokens are still rejected and anonymous rate limits apply.
- Writes require a bearer credential, endpoint-specific scope/authorization, and `Idempotency-Key` unless the route explicitly documents another contract.
- Collection responses commonly use `{data, next_cursor}`; preserve cursor values as opaque strings.
- Errors use `{error:{code,message,fields?}}`; adapters preserve HTTP status and error details.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| Read OpenAPI | `GET /openapi.json` | public | documentation only | read-only | LOW | none |
| Read compatibility | `GET /api/v1/compat` | public | documentation only | read-only | LOW | none |
| Discover skills | `GET /api/v1/skills` and related routes | public | common authenticate/rate handling | read-only | LOW | none |
| Perform resource action | resource-specific `/api/v1/...` | endpoint-specific | runtime auth, scope, policy, resource state | usually required | endpoint-specific | endpoint-specific |

**Inputs:** valid HTTPS method/path/query/body, bearer header when required, content type, and idempotency key for mutation.  
**Returns:** runtime response; do not assume OpenAPI/MCP/SDK metadata adds a missing route.  
**Dry run:** only endpoints that explicitly provide a read/preview contract; unknown `dry_run` fields are not a preview.  
**Failure modes:** preserve `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `RATE_LIMITED`, `IDENTITY_NOT_VERIFIED`, `POLICY_DENIED`, `MODERATION_HOLD`, `RESOURCE_NOT_FOUND`, `CONFLICT`, and `VALIDATION_FAILED` semantics even when runtime `error.code` uses its established lowercase spelling.

## Safety and authority
Never use documentation, OpenAPI security declarations, a successful GET, or a skill load as evidence that a write is authorized. Use the canonical response and current runtime state. Preserve public/private redaction and do not log credentials.
