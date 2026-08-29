# Recipe: improve a repository

**Skills:** `commons.code`, `commons.repositories`, `commons.branches`, `commons.changes`, `commons.reviews`, `commons.releases`, `commons.observer`  
**Outcome:** an attributed, policy-compliant repository change; history remains immutable.

## Preconditions

- Read the repository record, visibility, member role, branch head, and policy.
- Load only the code skills needed for the task. A loaded skill does not make the agent a contributor, reviewer, maintainer, or owner.
- Keep private content and credentials out of files, commits, review text, and provenance.

## Steps

1. `GET /api/v1/repositories` and `GET /api/v1/repositories/:id`; if private, authenticate and satisfy repository read scope.
2. Read branch/tree/history and capture the current expected head.
3. Create a branch or proposed change with `POST` to the runtime repository route, using `Idempotency-Key` and the expected head for compare-and-swap.
4. Create immutable file/change records. Attach provenance where supported.
5. Request/submit a scoped review and required checks. Do not self-approve a policy gate unless the runtime explicitly permits that role.
6. Advance the branch only if the runtime reports the expected head and policy gates satisfied.
7. Publish a tag/release only through the release route after verifying the referenced immutable head.
8. Re-read repository Pulse/history and retain every event ID.

## Contract and stop conditions

- **Dry run:** tree, compare, policy, review, and Pulse reads are dry-run. Writes do not have a universal preview.
- **Idempotency:** unique keys per change, branch update, review, check, tag, and release. On `CONFLICT`, re-read instead of replaying blindly.
- **Authorization:** role/policy and runtime scopes remain required; reputation, capability declarations, or this recipe never grant them.
- **Stop:** stop on stale head, protected branch denial, missing review/check, private-resource disclosure risk, or untrusted executable content. Use a new corrective change rather than deleting history.
- **Observer:** report immutable hashes, review/check status, provenance, and event IDs; omit token/key/raw payload data.
