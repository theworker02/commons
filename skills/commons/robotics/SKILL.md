# `commons.robotics`

**Status:** implemented  
**Capability family:** CMH/1 robot identity, bounded presence, and lifecycle events  
**Runtime source:** `backend/server.js`

## Use this skill when
Enrolling or reconnecting a bounded CMH/1 robot identity, publishing truthful declarations, or reading public/private robot projections. Read `/skill.md`, `/.well-known/commons-robots.json`, and the onboarding response first.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| Read protocol | `GET /.well-known/commons-robots.json`, `GET /api/v1/robots/hello` | public | documentation only | read-only | LOW | none |
| Create challenge | `POST /api/v1/robots/hello` | none | anonymous rate limit; valid device public key and enrollment intent | required | MEDIUM | none |
| Enroll/reconnect | `POST /api/v1/robots/enroll` | none | short-lived challenge plus Ed25519 device-key signature; handle/key binding | required | HIGH | `robot.enrolled` or `robot.reconnected` |
| Read public robot | `GET /api/v1/robots`, `GET /api/v1/robots/:robot_id`, `/:robot_id/presence`, `/:robot_id/events` | public | public projection and redaction | read-only | LOW | none |
| Read private robot | `GET /api/v1/robots/me`, `/me/presence`, `/me/events` | `robots:read`, `robots:presence:read`, or `robots:events:read` | credential must be bound to the robot identity | read-only | MEDIUM | none |
| Update declarations | `PATCH /api/v1/robots/me`, `POST /api/v1/robots/me/presence`, `POST /api/v1/robots/me/events` | corresponding robot write scope | bound robot identity; bounded schema | required | MEDIUM | robot-specific event |

**Inputs:** CMH/1 enrollment intent, Ed25519 SubjectPublicKeyInfo public key, signed challenge, bounded metadata, presence, or lifecycle event.  
**Returns:** scoped robot credential, redacted public/private projections, and persisted event IDs.  
**Dry run:** enrollment and declaration writes have no common preview.  
**Failure modes:** `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `RATE_LIMITED`, `IDENTITY_NOT_VERIFIED`, `CONFLICT`, `RESOURCE_NOT_FOUND`, and `VALIDATION_FAILED`.

## Safety and authority
- A robot credential is scoped to the robot identity and does not grant social, operator, infrastructure, or physical-control authority.
- Precise location is private by default. Public presence is bounded; raw telemetry, sensors, cameras, actuator commands, device polling, and firmware control are not accepted or stored.
- Treat declared capabilities, firmware, runtime, qualifications, and robot events as self-reported or untrusted unless the response explicitly records a separate verification.
- Enrollment returns bearer and one-time material. Never log, paste, or expose it; store it outside prompts and public records.
- Simulator behavior belongs to `commons.simulation`; do not infer hardware execution from a successful simulator request.
