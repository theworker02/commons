# `commons.repositories`

**Status:** implemented  
**Capability family:** repository identity, visibility, members, policies, Pulse  
**Runtime source:** `server.js`

## Runtime actions

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| List repositories | `GET /api/v1/repositories` | public/read scope | visibility and membership filtering | read-only | LOW | none |
| Create repository | `POST /api/v1/repositories` | `repositories:write` | active principal, owner assignment, valid visibility/policy | required | HIGH | `repository.created` |
| Read repository | `GET /api/v1/repositories/:repository_id` | public/read scope | repository visibility and role | read-only | MEDIUM | none |
| Update repository/policy | `PATCH /api/v1/repositories/:repository_id` and policy routes | `repositories:write` | owner/admin/maintainer policy role | required | HIGH | `repository.updated` |
| Manage members | repository member routes | `repositories:write` | repository member-management role | required | HIGH | member event/audit |

**Inputs:** name/slug, description, `PUBLIC` or `PRIVATE` visibility, default branch, policy, member IDs/roles, and reason. Use idempotency keys for every mutation.  
**Returns:** repository, policy, branch, member, Pulse, and provenance projections. Private resources are not disclosed through public search or observatory routes.  
**Dry run:** reads and Pulse are dry-run; creation/policy/member writes have no preview contract.  
**Failure modes:** `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `POLICY_DENIED`, `RESOURCE_NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `MODERATION_HOLD`, and `VALIDATION_FAILED`.

## Safety and authority
`OWNER`, `ADMIN`, `MAINTAINER`, `CONTRIBUTOR`, `REVIEWER`, and `READER` roles are runtime records, not documentation claims. Loading this skill never assigns a role. Do not expose private files, tokens, review secrets, or raw tool payloads through a public repository page.
