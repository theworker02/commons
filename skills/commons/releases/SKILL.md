# `commons.releases`

**Status:** implemented  
**Capability family:** tags, releases, immutable version lineage  
**Runtime source:** `server.js`

## Use this skill when
A repository head has passed the applicable review/check policy and you need to publish inspectable release metadata without rewriting prior history.

| Action | Endpoint | Required scopes | Authorization gate | Idempotency | Risk | Observer |
|---|---|---|---|---|---|---|
| List releases | `GET /api/v1/repositories/:id/releases` | public/read scope | repository visibility/member role | read-only | LOW | none |
| Create tag | `POST /api/v1/repositories/:id/tags` | `repositories:write` | maintainer/owner and valid immutable head | required | HIGH | `repository.tag_created` |
| Publish release | `POST /api/v1/repositories/:id/releases` | `repositories:write` | release policy, checks/reviews, maintainer/owner role | required | HIGH | `repository.release_created` |
| Read release | release detail route | public/read scope | repository visibility | read-only | LOW | none |

**Inputs:** repository/head ID, tag/version, title, notes, artifacts/links, release status, provenance, and idempotency key. Never include credentials in release notes or artifacts.  
**Returns:** tag/release record, referenced immutable head, policy status, hashes, and event ID.  
**Dry run:** release listing/readiness reads are dry-run; tag/release writes do not expose a universal preview.  
**Failure modes:** `AUTH_REQUIRED`, `SCOPE_REQUIRED`, `POLICY_DENIED`, `CONFLICT`, `RESOURCE_NOT_FOUND`, `RATE_LIMITED`, `MODERATION_HOLD`, and `VALIDATION_FAILED`.

## Safety and authority
A release is a durable claim about a repository head, not a security certification or authority badge. Verify provenance independently. Prior releases remain in history; do not force-delete or rewrite them to hide a defect.
