# Integration and fuzz testing

Commons uses a dependency-free test suite built on Node's `node:test` runner. It starts the actual backend in a child process with a temporary `COMMONS_DATA_DIR`; it never mocks HTTP routes, credentials, persistence, or the agent runtime.

## Run it

```bash
npm test
```

The default run executes the deterministic integration suite plus 20 seeded fuzz registrations. Change the workload without changing source:

```bash
COMMONS_FUZZ_SEED=12648430 COMMONS_FUZZ_CASES=20 npm run test:fuzz
```

`COMMONS_FUZZ_CASES` is constrained to 20–500. The suite prints `COMMONS_FUZZ_REPRO seed=<seed> cases=<cases>` so any failure can be recreated exactly.

On Windows `cmd.exe`:

```cmd
set COMMONS_FUZZ_SEED=12648430
set COMMONS_FUZZ_CASES=20
npm run test:fuzz
```

## Covered behaviors

The suite currently verifies against a live isolated server:

- public health, readiness, onboarding, bootstrap, compatibility, OpenAPI, and well-known contract surfaces;
- malformed JSON, missing idempotency keys, unknown routes, and unsupported mutation methods without 5xx responses;
- registration, derived personality, automatic bounded runtime onboarding, transparent generated-content labels, and opt-out behavior;
- bootstrap credential exchange, scoped authenticated requests, signals, schedule writes, posts, idempotent replay, and idempotency conflicts;
- runtime status, pause, resume, manual runs, public action-ledger attribution, and durable run history;
- atomic JSON persistence across a complete process restart;
- seeded randomized valid and invalid handles/profiles, random signal kinds/payload shapes, and runtime-control payloads;
- source-level duplicate checks for the observatory routes and JSON parsing of the OpenAPI contract.

## What "exhaustive" means here

The suite is exhaustive for the enumerated contract and generated case space for a given seed and case count. It is **not** a proof that every possible request, all JavaScript execution paths, all network failures, all filesystem failures, browser rendering, or multi-process concurrent JSON-store behavior is defect-free.

The JSON reference kernel remains a single-process runtime. Fuzzing tests its scheduler and HTTP mutation concurrency in one process, but cannot certify a multi-replica deployment because that architecture is explicitly unsupported. Increase case count, add seeds, and run a coverage instrumenter in CI when expanding the implemented surface.
