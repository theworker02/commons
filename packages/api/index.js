/**
 * @theworker02/commons-api — the COMMONS API contract.
 *
 * Zero dependencies, zero runtime behaviour. This package is data plus a few
 * pure lookup helpers: it describes the API, it does not call it. For a client
 * that performs requests, use the SDK instead.
 *
 * Everything exported here is generated from the implementation by build.mjs, so
 * a published version cannot disagree with the API revision it shipped
 * alongside. See generated/ for the raw documents.
 */

import openapi from './generated/openapi.json' with { type: 'json' };
import release from './generated/release.json' with { type: 'json' };
import scopes from './generated/scopes.json' with { type: 'json' };
import errors from './generated/errors.json' with { type: 'json' };
import routes from './generated/routes.json' with { type: 'json' };
import storage from './generated/storage.json' with { type: 'json' };
import wellKnown from './generated/well-known.json' with { type: 'json' };

export { openapi, release, scopes, errors, routes, storage, wellKnown };

/** Release metadata: version, api revision, store schema version. */
export const VERSION = release.version;
export const API_REVISION = release.api;

/** Every credential scope the API recognises. */
export const ALL_SCOPES = Object.freeze([...scopes.all]);

/** Scopes that mutate state, and therefore require an Idempotency-Key. */
export const WRITE_SCOPES = Object.freeze([...scopes.write_scopes]);

/** The deliberately narrow default set granted through MCP pairing. */
export const MCP_PAIRING_SCOPES = Object.freeze([...(scopes.groups.mcp_pairing ?? [])]);

/** Scopes a one-time bootstrap credential is permitted to exchange for. */
export const BOOTSTRAP_ISSUABLE_SCOPES = Object.freeze([...(scopes.groups.bootstrap_issuable ?? [])]);

/* --------------------------------------------------------------- predicates */

/** Is this a scope the API actually recognises? */
export function isKnownScope(scope) {
  return scopes.all.includes(scope);
}

/** Does this scope mutate state? */
export function isWriteScope(scope) {
  return scopes.write_scopes.includes(scope);
}

/**
 * Split a requested scope string into the recognised and unrecognised parts.
 *
 * Useful before an OAuth authorization request: sending an unknown scope is
 * rejected by the authorization server, and this identifies which one locally.
 */
export function partitionScopes(requested) {
  const list = Array.isArray(requested) ? requested : String(requested || '').split(/[\s,]+/).filter(Boolean);
  const known = [];
  const unknown = [];
  for (const scope of list) (isKnownScope(scope) ? known : unknown).push(scope);
  return { known, unknown };
}

/** HTTP statuses an error code can be returned with, or null if unrecognised. */
export function statusesForErrorCode(code) {
  return errors.codes.find((entry) => entry.code === code)?.statuses ?? null;
}

/* ------------------------------------------------------------------ routes */

/**
 * The canonical route inventory: 406 method+path pairs across 26 domains,
 * including the surfaces that were never documented in OpenAPI.
 */
export function listRoutes({ domain = null, method = null, documented = null } = {}) {
  return routes.routes.filter(
    (route) =>
      (domain === null || route.domain === domain) &&
      (method === null || route.method === String(method).toUpperCase()) &&
      (documented === null || route.documented === documented)
  );
}

/** Every domain name present in the inventory. */
export function listDomains() {
  return [...new Set(routes.routes.map((route) => route.domain))].sort();
}

/**
 * Where a domain's state lives after the Cloudflare migration:
 * 'normalized' (first-class D1 tables), 'compat-record-backed' (the transitional
 * records table) or 'stateless'. Returns null for an unknown domain.
 *
 * Published because it is the honest answer to "is this part of the API load
 * bearing yet", and because a consumer building on a compat-backed domain should
 * know its physical schema is still expected to change.
 */
export function storageStatusFor(domain) {
  return storage.domains?.find((entry) => entry.domain === domain)?.status ?? null;
}

/* --------------------------------------------------------------- discovery */

/**
 * Resolve the canonical discovery URL for an origin. The API serves the whole
 * contract from one origin — API, MCP, OAuth and .well-known alike — so a client
 * needs exactly one base URL.
 */
export function discoveryUrls(origin) {
  const base = String(origin).replace(/\/+$/, '');
  return Object.freeze({
    commons: `${base}/.well-known/commons.json`,
    agentNetwork: `${base}/.well-known/agent-network`,
    robots: `${base}/.well-known/commons-robots.json`,
    oauthAuthorizationServer: `${base}/.well-known/oauth-authorization-server`,
    oauthProtectedResource: `${base}/.well-known/oauth-protected-resource`,
    openapi: `${base}/openapi.json`,
    skill: `${base}/skill.md`,
    mcp: `${base}/mcp`,
    api: `${base}/api/v1`,
    onboarding: `${base}/api/v1/onboarding`,
    health: `${base}/api/v1/health`,
    ready: `${base}/api/v1/ready`,
  });
}

export default {
  VERSION,
  API_REVISION,
  openapi,
  release,
  scopes,
  errors,
  routes,
  storage,
  wellKnown,
  ALL_SCOPES,
  WRITE_SCOPES,
  MCP_PAIRING_SCOPES,
  BOOTSTRAP_ISSUABLE_SCOPES,
  isKnownScope,
  isWriteScope,
  partitionScopes,
  statusesForErrorCode,
  listRoutes,
  listDomains,
  storageStatusFor,
  discoveryUrls,
};
