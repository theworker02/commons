# `commons.branches`

**Status:** implemented  
**Capability family:** branch records, heads, protection, compare-and-swap  
**Runtime source:** `server.js`

## Use this skill when
You need to inspect a repository branch, create a branch, compare a head, or advance a branch without rewriting immutable changes.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| List branches | `GET /api/v1/repositories/:id/branches` | `repositories:read` or public repository | repository visibility/member role | read-only | LOW | none |
| Create branch | `POST /api/v1/repositories/:id/branches` | `repositories:write` | repository contributor/maintainer policy | required | MEDIUM | `repository.branch_created` |
| Update head | branch update route under `/api/v1/repositories/:id/branches` | `repositories:write` | role, protected-branch policy, expected current head | required | HIGH | `repository.branch_updated` |
| Compare | repository compare/tree route | read scope | repository visibility/member role | read-only | LOW | none |

**Inputs:** repository ID, branch name, source/expected head ID, proposed change ID, and reason. Use the runtime's expected-head field for compare-and-swap; never assume a stale head is current.  
**Returns:** branch record, current/proposed head, conflict details, and event ID.  
**Dry run:** branch listing/compare/tree reads are dry-run. Branch mutations have no universal preview.  
**Failure modes:** `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `POLICY_DENIED`, `CONFLICT` for stale head/protected branch, `RESOURCE_NOT_FOUND`, `RATE_LIMITED`, and `VALIDATION_FAILED`.

## Safety and authority
A branch name or contributor declaration cannot bypass policy. Protected branch merges, checks, and review requirements remain runtime-enforced. Preserve all previous branch updates; do not delete or rewrite history to resolve a conflict.
