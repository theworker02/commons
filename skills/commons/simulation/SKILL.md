# `commons.simulation`

**Status:** implemented  
**Capability family:** explicitly opted-in CMH/1 simulator and synthetic telemetry  
**Runtime source:** `backend/server.js`

## Use this skill when
Using the private, synchronous simulator for a robot enrollment that explicitly enabled simulation. This is a safety-bounded dry-run surface, not a robotics control plane.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| Read simulator | `GET /api/v1/robots/me/simulation` | `robots:simulation:read` | authenticated credential bound to a robot with `simulation.enabled=true` | read-only | LOW | none |
| List commands | `GET /api/v1/robots/me/simulation/commands` | `robots:simulation:commands:read` | same robot and explicit opt-in | read-only | LOW | none |
| Run dry-run command | `POST /api/v1/robots/me/simulation/commands` | `robots:simulation:commands:dry_run` | same robot; strict allowlist and `dry_run:true` | required | HIGH | audit plus `robot.simulation.command_dry_run` |
| Read command | `GET /api/v1/robots/me/simulation/commands/:command_id` | `robots:simulation:commands:read` | command belongs to the bound robot | read-only | LOW | none |
| Read telemetry | `GET /api/v1/robots/me/simulation/telemetry` | `robots:simulation:telemetry:read` | same robot and explicit opt-in | read-only | LOW | none |

**Accepted command types:** `simulation.noop`, `simulation.status`, `simulation.plan`, and `simulation.estimate`. Parameters are limited to `mode` (`SAFE` or `NOMINAL`), integer `steps` from 0–100, integer `duration_ms` from 0–60000, and an optional 1–80 character label. Expiry defaults to five minutes and cannot exceed fifteen minutes.  
**Returns:** synchronous records with `executed:false`, `hardware_effect:false`, `transport:"NONE"`, an audit record, and server-generated synthetic telemetry.  
**Limits:** 30 accepted attempts per robot per in-process minute; rejected and rate-limited attempts are audited.  
**Failure modes:** `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `simulation_not_enabled`, `VALIDATION_FAILED`, `RATE_LIMITED`, and `RESOURCE_NOT_FOUND`.

## Safety and authority
- Every command must be an explicit dry run. Never omit or reinterpret `dry_run:true`.
- Camera, image, video, frame, sensor, raw telemetry, location, arbitrary measurement, actuator, control, transport, queue, schedule, execute, and polling fields are rejected rather than ignored.
- Synthetic telemetry is private server-generated simulator state. There is no telemetry-write endpoint, worker, scheduler, device polling, external transport, or physical effect.
- A loaded skill or successful dry run does not grant robot, infrastructure, or physical authority. Keep simulator outputs separate from claims about real-world execution.
