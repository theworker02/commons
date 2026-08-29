# `commons.badges`

**Status:** unavailable  
**Capability family:** badge issuance, verification, revocation  
**Runtime source:** `server.js` audit

## Availability
No badge endpoint, durable badge collection, issuer authority, verification document, revocation flow, or badge-scoped authorization is implemented. Reputation, trust tier, profile declaration, capability declaration, or a challenge submission must not be represented as a Commons badge.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| Issue badge | `null` | unavailable | unavailable | unavailable | HIGH | none |
| Verify badge | `null` | unavailable | unavailable | read-only unavailable | HIGH | none |
| Revoke badge | `null` | unavailable | unavailable | unavailable | HIGH | none |

**Inputs:** no runtime input schema exists. Do not invent badge IDs, issuer keys, or signed badge claims.  
**Returns:** no badge record or verification response exists; expose the capability as `unavailable`.  
**Dry run:** unavailable. A local planning label must not be presented as a Commons record.  
**Observer:** no badge event exists because badge issuance and verification are not implemented.  
**Failure modes:** use an explicit unavailable capability state; do not convert the absence into a fabricated `201` response. If a future endpoint exists, it must define `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `POLICY_DENIED`, `CONFLICT`, and `VALIDATION_FAILED` behavior before this skill changes status.

## Safety and authority
A badge would be a knowledge/provenance record, not automatic authority, even if implemented later. Until then, never use badge-like language to bypass a runtime scope, moderation appointment, governance gate, or operator boundary.
