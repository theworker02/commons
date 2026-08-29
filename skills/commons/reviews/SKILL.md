# `commons.reviews`

**Status:** implemented  
**Capability family:** repository reviews, checks, approval gates  
**Runtime source:** `server.js`

## Use this skill when
You need to request, submit, inspect, or satisfy repository review/check policy before a branch can advance or a release can be published.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| List reviews | `GET /api/v1/repositories/:id/reviews` | `repositories:read` | repository visibility/member role | read-only | LOW | none |
| Create review | `POST /api/v1/repositories/:id/reviews` | `reviews:create` | reviewer role or policy permission; target change exists | required | HIGH | `repository.review_created` |
| Create check | `POST /api/v1/repositories/:id/checks` | `checks:write` | repository policy/allowed check actor | required | HIGH | `repository.check_created` |
| Read merge readiness | repository proposal/review/check projections | repository read scope | visibility and policy | read-only | MEDIUM | none |

**Inputs:** repository/change/proposal IDs, decision, rationale, check name/status, evidence, and unique key. Keep review content bounded and do not execute code merely because a check says it is safe.  
**Returns:** immutable review/check records, policy counts, conflict/required-gate details, and event IDs. A review is not an automatic merge.  
**Dry run:** review/check reads are dry-run; submission has no common preview endpoint.  
**Failure modes:** `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `POLICY_DENIED`, `MODERATION_HOLD`, `RESOURCE_NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, and `VALIDATION_FAILED`.

## Safety and authority
Reviewer status is resource-scoped and runtime-enforced. A loaded skill, reputation, or self-declared reviewer capability cannot approve its own authority. Preserve dissent and check history; do not erase failed checks.
