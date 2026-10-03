import { z } from 'zod';
import {
  MAX_CAPABILITIES,
  MAX_IDENTIFIER_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_VERSIONS,
} from './constants.js';
import { ERROR_CODES, ProtocolError } from './errors.js';
import { assertWithinMessageLimit, utf8ByteLength } from './bytes.js';

const identifier = z
  .string()
  .min(1)
  .refine((s) => utf8ByteLength(s) <= MAX_IDENTIFIER_BYTES, 'identifier too long');
const catalogVersion = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const versionList = z
  .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .min(1)
  .max(MAX_VERSIONS)
  .refine((l) => new Set(l).size === l.length, 'duplicate versions');
const capabilities = z.array(identifier).max(MAX_CAPABILITIES);
const errorBody = z.strictObject({
  code: z.enum(ERROR_CODES).or(z.string().min(1).max(64)),
  message: z.string().max(512),
});

export const ClientHelloSchema = z.strictObject({
  type: z.literal('hello'),
  supportedProtocolVersions: versionList,
  protocolPackageVersion: identifier,
  catalogVersion,
  clientVersion: identifier,
  installationId: identifier,
  profileEpoch: identifier,
  platform: identifier,
  capabilities,
});

export const ServerHelloSchema = z.strictObject({
  type: z.literal('hello_ack'),
  protocolVersion: z.number().int().positive(),
  protocolPackageVersion: identifier,
  catalogVersion,
  serverVersion: identifier,
  browserId: identifier,
  connectionId: identifier,
  house: identifier,
  capabilities,
});

export const HelloRejectSchema = z.strictObject({
  type: z.literal('hello_reject'),
  error: errorBody,
  supportedProtocolVersions: versionList.optional(),
});

export const ToolRequestSchema = z.strictObject({
  type: z.literal('tool_request'),
  id: identifier,
  sessionId: identifier,
  connectionId: identifier,
  tabHandle: identifier.optional(),
  tool: identifier,
  args: z.record(z.string(), z.unknown()),
});

export const ToolResultSchema = z
  .strictObject({
    type: z.literal('tool_result'),
    id: identifier,
    sessionId: identifier,
    connectionId: identifier,
    house: identifier,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: errorBody.optional(),
  })
  .refine((r) => (r.ok ? r.error === undefined : r.error !== undefined && r.data === undefined), {
    message: 'ok:true needs no error; ok:false needs error and no data',
  });

export const SessionCloseSchema = z.strictObject({
  type: z.literal('session_close'),
  sessionId: identifier,
  connectionId: identifier,
});

export const RequestCancelSchema = z.strictObject({
  type: z.literal('request_cancel'),
  id: identifier,
  sessionId: identifier,
  connectionId: identifier,
});

export const HeartbeatSchema = z.strictObject({ type: z.literal('heartbeat') });
export const HeartbeatAckSchema = z.strictObject({ type: z.literal('heartbeat_ack') });

/** Frames the extension may send once the socket is open. */
export const ClientFrameSchema = z.union([
  ClientHelloSchema,
  ToolResultSchema,
  HeartbeatSchema,
]);
/** Frames the server may send. */
export const ServerFrameSchema = z.union([
  ServerHelloSchema,
  HelloRejectSchema,
  ToolRequestSchema,
  SessionCloseSchema,
  RequestCancelSchema,
  HeartbeatAckSchema,
]);

export type ClientHello = z.infer<typeof ClientHelloSchema>;
export type ServerHello = z.infer<typeof ServerHelloSchema>;
export type HelloReject = z.infer<typeof HelloRejectSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type SessionClose = z.infer<typeof SessionCloseSchema>;
export type RequestCancel = z.infer<typeof RequestCancelSchema>;
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** Opaque, never a Chrome numeric tab id. */
export type TabHandle = string;
export interface SessionBinding {
  sessionId: string;
  browserId: string;
  connectionId: string;
  house: string;
}

function parseJson(text: string, byteLength: number): unknown {
  assertWithinMessageLimit(byteLength, MAX_MESSAGE_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProtocolError('invalid_message', 'frame is not valid JSON');
  }
}

function strict<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProtocolError('invalid_message', 'frame does not match the protocol schema');
  return parsed.data;
}

/** Size check happens BEFORE JSON.parse. `byteLength` is the received byte count when known. */
export function parseClientFrame(text: string, byteLength: number = utf8ByteLength(text)): ClientFrame {
  return strict(ClientFrameSchema, parseJson(text, byteLength));
}
export function parseServerFrame(text: string, byteLength: number = utf8ByteLength(text)): ServerFrame {
  return strict(ServerFrameSchema, parseJson(text, byteLength));
}

/** Serialize an outbound frame, enforcing the limit before it is enqueued/sent. */
export function serializeFrame(frame: ClientFrame | ServerFrame): string {
  const text = JSON.stringify(frame);
  assertWithinMessageLimit(utf8ByteLength(text));
  return text;
}
