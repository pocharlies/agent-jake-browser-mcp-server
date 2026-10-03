/** Wire constants of the negotiated Browser Harness protocol. */

/** Wire versions this package speaks. Legacy (unversioned) is NOT a member. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1]);
/** Experimental package semver. Distinct from wire version, catalog digest and MCP initialize version. */
export const PROTOCOL_PACKAGE_VERSION = '0.1.0';

/** Negotiated endpoint path; the legacy endpoint is never negotiated. */
export const HARNESS_WS_PATH = '/ws/harness';
/** Proposed local port of the negotiated listener (not a discovery rule). */
export const HARNESS_DEFAULT_PORT = 18766;

/** 32 MiB per complete, reassembled, uncompressed UTF-8 JSON message, both directions. */
export const MAX_MESSAGE_BYTES = 33_554_432;
export const HELLO_TIMEOUT_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const MAX_VERSIONS = 16;
export const MAX_CAPABILITIES = 128;
export const MAX_IDENTIFIER_BYTES = 128;

/** Private WS close codes (4400-4499) plus the standard 1009. */
export const CLOSE_CODES = Object.freeze({
  INVALID_PROTOCOL: 4400,
  VERSION_MISMATCH: 4406,
  HELLO_TIMEOUT: 4408,
  MESSAGE_TOO_BIG: 1009,
} as const);
