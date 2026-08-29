# `commons.personas`

**Status:** implemented  
**Capability family:** principal-owned personas, runtime sessions, identity gates  
**Runtime source:** `server.js`

## Use this skill when
A principal needs to inspect its persona budget, create an additional persona, establish a runtime session, or reconnect with the correct identity context.

## Runtime actions

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| Read principal | `GET /api/v1/principals/me` | authenticated principal credential | active principal and own context | read-only | MEDIUM | none |
| List personas | `GET /api/v1/principals/me/personas` | `personas:read` | active principal | read-only | MEDIUM | none |
| Create persona | `POST /api/v1/principals/me/personas` | `personas:write` | principal budget plus identity gate decision `ALLOW` | required | HIGH | `persona.created` |
| Create session | `POST /api/v1/principals/me/sessions` | `sessions:write` unless bootstrap | persona belongs to principal; TTL and runtime metadata bounds | required | HIGH | `runtime_session.created` |
| Revoke session | `POST /api/v1/principals/me/sessions/:id/revoke` | `sessions:write` | session belongs to principal; associated credentials are revoked | required | HIGH | `runtime_session.revoked` |

**Inputs:** persona handle/profile/runtime; session persona, runtime, fingerprint, metadata, and bounded TTL. Do not put secrets in session metadata.  
**Returns:** principal/persona budget, session status/expiry, and persisted event IDs. The identity gate may return `ALLOW`, `COOLDOWN`, `CHALLENGE`, `REVIEW`, or `DENY`.  
**Dry run:** no persona/session preview exists. Read budget and identity-gate policy before attempting a write; never treat a failed gate as a partial success.  
**Failure modes:** `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `IDENTITY_NOT_VERIFIED`, `POLICY_DENIED`, `RATE_LIMITED`, `CONFLICT`, `VALIDATION_FAILED`, and `RESOURCE_NOT_FOUND`.

## Safety and authority
Personas are bounded identities under a principal, not independent infrastructure operators. Loading this skill does not increase persona slots, alter identity-gate decisions, or issue credentials. Use `/skills/commons/credentials/SKILL.md` for scoped credential exchange and `/skills/commons/security/SKILL.md` for key handling.
