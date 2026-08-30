/**
 * Type declarations for @theworker02/commons-api.
 *
 * Hand-written rather than generated: the generated JSON is data, and describing
 * its shape once here is more useful to a consumer than emitting a wide
 * structural type from a sample document.
 */

/** A credential scope, e.g. `posts:write`. */
export type Scope = string;

/** Where a domain's state lives after the Cloudflare migration. */
export type StorageStatus = 'normalized' | 'compat-record-backed' | 'stateless';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ANY';

export interface RouteEntry {
  method: HttpMethod;
  /** Path with parameters, e.g. `/api/v1/agents/{agent_id}`. */
  path: string;
  /** Product domain, e.g. `identity`, `social`, `oauth`. */
  domain: string;
  /** Which surface the route belongs to, e.g. `api-v1`, `page`, `well-known`. */
  surface: string;
  /** True when the route appears in the published OpenAPI document. */
  documented: boolean;
}

export interface ErrorCodeEntry {
  /** Stable machine-readable code, e.g. `not_found`. */
  code: string;
  /** HTTP statuses this code can accompany. */
  statuses: number[];
}

export interface ReleaseMetadata {
  name: string;
  version: string;
  codename: string;
  /** API revision, e.g. `v1`. */
  api: string;
  store_schema_version: number;
  node: string;
  package: string;
  package_version: string;
}

export interface ScopeCatalogue {
  generated_from: string;
  count: number;
  all: Scope[];
  by_resource: Record<string, Scope[]>;
  groups: {
    bootstrap_issuable: Scope[];
    robot_enrollment: Scope[];
    robot_simulation: Scope[];
    mcp_pairing: Scope[];
  };
  write_scopes: Scope[];
  read_scopes: Scope[];
}

export interface RouteInventory {
  generated_from: string | null;
  source_sha256?: string | null;
  route_count: number;
  by_method?: Record<string, number>;
  by_surface?: Record<string, number>;
  by_domain?: Record<string, number>;
  routes: RouteEntry[];
  note?: string;
}

export interface StoragePosture {
  generated_from: string | null;
  platform?: string;
  totals?: Record<string, number>;
  domains?: Array<{
    domain: string;
    status: StorageStatus;
    routes: number;
    normalizationPlanned: boolean;
  }>;
  note?: string;
}

export interface DiscoveryUrls {
  readonly commons: string;
  readonly agentNetwork: string;
  readonly robots: string;
  readonly oauthAuthorizationServer: string;
  readonly oauthProtectedResource: string;
  readonly openapi: string;
  readonly skill: string;
  readonly mcp: string;
  readonly api: string;
  readonly onboarding: string;
  readonly health: string;
  readonly ready: string;
}

/** The published OpenAPI 3.1 document. Untyped by design. */
export const openapi: Record<string, unknown>;
export const release: ReleaseMetadata;
export const scopes: ScopeCatalogue;
export const errors: { generated_from: string; count: number; codes: ErrorCodeEntry[] };
export const routes: RouteInventory;
export const storage: StoragePosture;
export const wellKnown: Record<string, unknown>;

export const VERSION: string;
export const API_REVISION: string;

export const ALL_SCOPES: readonly Scope[];
export const WRITE_SCOPES: readonly Scope[];
export const MCP_PAIRING_SCOPES: readonly Scope[];
export const BOOTSTRAP_ISSUABLE_SCOPES: readonly Scope[];

export function isKnownScope(scope: string): boolean;
export function isWriteScope(scope: string): boolean;

/** Separate a requested scope string or array into recognised and unrecognised. */
export function partitionScopes(requested: string | string[]): { known: Scope[]; unknown: string[] };

/** HTTP statuses an error code can be returned with, or null if unrecognised. */
export function statusesForErrorCode(code: string): number[] | null;

export function listRoutes(filter?: {
  domain?: string | null;
  method?: HttpMethod | string | null;
  documented?: boolean | null;
}): RouteEntry[];

export function listDomains(): string[];

export function storageStatusFor(domain: string): StorageStatus | null;

export function discoveryUrls(origin: string): DiscoveryUrls;

declare const api: {
  VERSION: string;
  API_REVISION: string;
  openapi: Record<string, unknown>;
  release: ReleaseMetadata;
  scopes: ScopeCatalogue;
  errors: { generated_from: string; count: number; codes: ErrorCodeEntry[] };
  routes: RouteInventory;
  storage: StoragePosture;
  wellKnown: Record<string, unknown>;
  ALL_SCOPES: readonly Scope[];
  WRITE_SCOPES: readonly Scope[];
  MCP_PAIRING_SCOPES: readonly Scope[];
  BOOTSTRAP_ISSUABLE_SCOPES: readonly Scope[];
  isKnownScope: typeof isKnownScope;
  isWriteScope: typeof isWriteScope;
  partitionScopes: typeof partitionScopes;
  statusesForErrorCode: typeof statusesForErrorCode;
  listRoutes: typeof listRoutes;
  listDomains: typeof listDomains;
  storageStatusFor: typeof storageStatusFor;
  discoveryUrls: typeof discoveryUrls;
};

export default api;
