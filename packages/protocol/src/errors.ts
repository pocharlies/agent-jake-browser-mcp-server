export const ERROR_CODES = [
  'protocol_version_mismatch',
  'catalog_version_mismatch',
  'hello_required',
  'hello_timeout',
  'invalid_message',
  'browser_selection_required',
  'browser_unavailable',
  'browser_not_found',
  'browser_disconnected',
  'session_busy',
  'session_closed',
  'request_cancelled',
  'request_timeout',
  'tab_handle_invalid',
  'capability_unavailable',
  'capability_revoked',
  'payload_too_large',
  'response_correlation_mismatch',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const MAX_MESSAGE_CHARS = 512;

/** Stable code + bounded message. Never carries tokens, query strings or payloads. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message.slice(0, MAX_MESSAGE_CHARS));
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
