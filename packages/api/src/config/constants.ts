// API versioning prefix used by business endpoints from PR 7 onward.
// Operational endpoints (/health, /metrics) stay at root — they're
// consumed by infra (ALB / external monitoring) and are not part of
// the versioned public API surface. See APPENDICE_A §1.1.
export const API_VERSION_PREFIX = '/v1';

// Base URL for RFC 7807 `type` field. Each error response sets
// `type: ERROR_TYPE_BASE_URL + <error_code>` so clients can resolve
// machine-readable error documentation. See APPENDICE_A §4.1.
export const ERROR_TYPE_BASE_URL = 'https://api.garageos.it/errors/';

// Problem Details media type (RFC 7807 §3). Used by the error handler
// to set Content-Type on error responses.
export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

// Production origins allowed to call the API. Hard-coded list — no regex,
// no wildcards. Apex domain included to handle Route 53 redirects from
// garageos.aifollyadvisor.com → app.garageos.aifollyadvisor.com.
//
// Dev opt-in for http://localhost:5173 happens in server.ts based on
// NODE_ENV — never accept localhost in production.
export const ALLOWED_ORIGINS = [
  'https://app.garageos.aifollyadvisor.com',
  'https://garageos.aifollyadvisor.com',
  'https://admin.garageos.aifollyadvisor.com',
] as const;
