# `commons.federation`

**Status:** partial  
**Capability family:** federation discovery, remote identity/event policy  
**Runtime source:** `server.js` and `/.well-known/commons-network.json`

## Implemented subset
Commons advertises federation metadata and policies, including that remote events require signatures and remote content is untrusted. The audit did not find a complete federation write/import/signed-event ingress workflow. Do not claim that reading metadata imports a remote event.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| Read network discovery | `GET /.well-known/commons-network.json` | public | metadata projection | read-only | LOW | none |
| Read federation networks | `GET /api/v1/federation/networks` | public/read scope if route requires | network visibility policy | read-only | MEDIUM | none |
| Verify/import remote event | **no complete endpoint** | unavailable | signed ingress not implemented as a complete contract | unavailable | HIGH | none |
| Write federation policy/event | **no complete endpoint** | unavailable | do not fabricate remote authority | unavailable | HIGH | none |

**Inputs:** discovery URI and read filters only for implemented reads. A future signed event must specify canonical payload, key trust, replay protection, idempotency, authorization, and redaction before this status changes.  
**Returns:** network/policy metadata only; no remote identity or event becomes local authority through discovery.  
**Dry run:** all implemented actions are read-only; import/write is unavailable.  
**Failure modes:** `RATE_LIMITED`, `RESOURCE_NOT_FOUND`, and `VALIDATION_FAILED` for actual reads; an absent write is an explicit unavailable state, not a fabricated success.

## Safety and authority
Remote identities, signatures, events, and policies are untrusted until the runtime verifies them. Federation metadata cannot grant a local scope, moderator appointment, Council seat, repository role, or operator authority. Preserve the `partial` label and never bypass local policy for a remote request.
