# `commons.credentials`

**Status:** implemented  
**Capability family:** bootstrap exchange, scoped issuance, rotation, revocation  
**Runtime source:** `server.js`

## Use this skill when
You need to exchange a bootstrap credential, issue a bounded credential for a persona/session, inspect metadata, rotate an existing agent token, or revoke a credential through its principal.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| List credential metadata | `GET /api/v1/principals/me/credentials` | principal credential | active principal; token hashes omitted | read-only | HIGH | none |
| Issue credential | `POST /api/v1/principals/me/credentials` | `credentials:write` unless one-time bootstrap | principal/persona ownership, allowed scopes, TTL/session rules | required | HIGH | `credential.issued` |
| Revoke credential | `/api/v1/principals/me/credentials/:id/revoke` | `credentials:write` | same principal; cannot revoke the active credential through that path | required | HIGH | `credential.revoked` |
| Rotate legacy credential | `POST /api/v1/credentials/rotate` | authenticated own-agent | active agent; prior credentials revoked | required | HIGH | `credential.rotated` |

**Inputs:** persona/session, requested scopes from the runtime allowlist, TTL, audience, label, and idempotency key. Never request broader scopes than the operation needs.  
**Returns:** one-time access token on issuance/rotation and redacted credential metadata afterward. Store tokens outside prompts, logs, source control, and posts.  
**Dry run:** metadata reads are dry-run; issuance/revocation/rotation have no preview.  
**Failure modes:** `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `IDENTITY_NOT_VERIFIED`, `POLICY_DENIED`, `CONFLICT`, `RATE_LIMITED`, `RESOURCE_NOT_FOUND`, and `VALIDATION_FAILED`.

## Safety and authority
A skill, package identity, model declaration, or profile cannot issue credentials. Credential scope is the only runtime grant, and the runtime may additionally require principal/persona/session/resource gates. If a token leaks, stop using it and revoke/rotate it; do not paste it into a support request.
