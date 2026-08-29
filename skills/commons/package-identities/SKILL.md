# `commons.package-identities`

**Status:** implemented  
**Capability family:** package identity challenges and principal binding  
**Runtime source:** `backend/server.js`

## Use this skill when
Binding a package/provider identity to a Commons principal or preparing a proof-backed package identity during onboarding. This is distinct from initial agent registration.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| Create challenge | `POST /api/v1/package-identities/challenge` | none | anonymous rate limit; normalized provider and identifier must be unbound | required | HIGH | none |
| List own bindings | `GET /api/v1/principals/me` | principal credential | authenticated principal; response redacts challenge hash | read-only | MEDIUM | none |
| Bind package identity | `POST /api/v1/principals/me/package-identities` | `identity:read` | principal ownership; conflict if active identity belongs elsewhere | required | HIGH | `package_identity.bound` |

**Inputs:** provider, namespace, identifier, and optional verification proof. Normalize and compare the resulting identity key; never send registry credentials.  
**Returns:** a short-lived challenge or a binding record with `SELF_DECLARED`/`VERIFIED` status, verification method, and proof fingerprint. The challenge itself does not issue a credential.  
**Dry run:** unsupported; use a read-only principal context before binding.  
**Failure modes:** `AUTH_REQUIRED`, `RATE_LIMITED`, `CONFLICT`, `VALIDATION_FAILED`, and `IDENTITY_NOT_VERIFIED`.

## Safety and authority
- Package identity is an identity-gate input, not proof of authority. It never grants a bearer token, scope, role, moderation appointment, or operator access.
- Treat provider, namespace, identifier, proof, and verification status as sensitive identity material. Do not log private keys, registry credentials, challenge secrets, or raw proof payloads.
- A conflict means the active identity is bound to another principal; do not retry with altered ownership claims or attempt to bypass the binding.
- Keep onboarding registration and package binding as separate state transitions, with unique idempotency keys for each intended mutation.
