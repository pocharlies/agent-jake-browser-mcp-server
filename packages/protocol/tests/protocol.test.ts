import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  ClientHelloSchema,
  MAX_MESSAGE_BYTES,
  ProtocolError,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_CATALOG,
  assertWithinMessageLimit,
  canonicalJson,
  computeCatalogDigest,
  isValidVersionList,
  negotiateVersion,
  parseClientFrame,
  parseServerFrame,
  serializeFrame,
  sha256Hex,
  utf8ByteLength,
} from '../src/index.js';

const hello = {
  type: 'hello',
  supportedProtocolVersions: [1],
  protocolPackageVersion: '0.1.0',
  catalogVersion: CATALOG_VERSION,
  clientVersion: '2.4.0',
  installationId: 'inst-1',
  profileEpoch: 'epoch-1',
  platform: 'linux',
  capabilities: [],
};

describe('negotiateVersion', () => {
  it('picks the greatest common integer regardless of order', () => {
    expect(negotiateVersion([1, 2, 3], [3, 2])).toBe(3);
    expect(negotiateVersion([3, 2], [1, 2, 3])).toBe(3);
    expect(negotiateVersion([2, 3, 1], [1, 3, 2])).toBe(3);
  });
  it('returns null for disjoint lists and does not mutate inputs', () => {
    const a = [3, 1];
    const b = [2, 4];
    expect(negotiateVersion(a, b)).toBeNull();
    expect(a).toEqual([3, 1]);
    expect(b).toEqual([2, 4]);
  });
  it('validates lists: empty, duplicate, non-positive, oversized', () => {
    expect(isValidVersionList([1])).toBe(true);
    expect(isValidVersionList([])).toBe(false);
    expect(isValidVersionList([1, 1])).toBe(false);
    expect(isValidVersionList([0])).toBe(false);
    expect(isValidVersionList([-1])).toBe(false);
    expect(isValidVersionList([1.5])).toBe(false);
    expect(isValidVersionList(Array.from({ length: 17 }, (_, i) => i + 1))).toBe(false);
    expect(isValidVersionList(Array.from({ length: 16 }, (_, i) => i + 1))).toBe(true);
  });
});

describe('sha256 / catalog digest', () => {
  it.each(['', 'abc', 'ñandú ✓ 𝄞', 'x'.repeat(1000)])('matches node:crypto for %j', (s) => {
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });
  it('canonical JSON sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: undefined } })).toBe('{"a":{"d":[3,1]},"b":1}');
  });
  it('digest is sha256:<hex>, sorted by name and independent of input order', () => {
    expect(CATALOG_VERSION).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeCatalogDigest([...TOOL_CATALOG].reverse())).toBe(CATALOG_VERSION);
  });
  it('any descriptor change changes the digest', () => {
    const changed = TOOL_CATALOG.map((t, i) => (i === 0 ? { ...t, risk: 'dangerous' as const } : t));
    expect(computeCatalogDigest(changed)).not.toBe(CATALOG_VERSION);
  });
  it('the catalog has unique names and the wire version list is [1]', () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual([1]);
  });
});

describe('strict frames', () => {
  it('accepts a valid hello', () => {
    expect(parseClientFrame(JSON.stringify(hello)).type).toBe('hello');
  });
  it.each([
    ['extra key', { ...hello, house: 'pocharlies' }],
    ['requested authoritative house', { ...hello, requestedHouse: 'x' }],
    ['duplicate versions', { ...hello, supportedProtocolVersions: [1, 1] }],
    ['empty versions', { ...hello, supportedProtocolVersions: [] }],
    ['bad catalog', { ...hello, catalogVersion: 'sha256:xyz' }],
    ['identifier over 128 bytes', { ...hello, installationId: 'é'.repeat(65) }],
    ['129 capabilities', { ...hello, capabilities: Array.from({ length: 129 }, (_, i) => `c${i}`) }],
  ])('rejects hello with %s as invalid_message', (_name, frame) => {
    expect(() => parseClientFrame(JSON.stringify(frame))).toThrowError(
      expect.objectContaining({ code: 'invalid_message' }),
    );
  });
  it('rejects a legacy frame and non-JSON', () => {
    expect(() => parseClientFrame(JSON.stringify({ id: 'x', success: true, result: {} }))).toThrow(ProtocolError);
    expect(() => parseClientFrame('not json')).toThrow(ProtocolError);
  });
  it('tool_result: ok needs no error, failure needs error and no data', () => {
    const base = { type: 'tool_result', id: 'r', sessionId: 's', connectionId: 'c', house: 'h' };
    expect(parseClientFrame(JSON.stringify({ ...base, ok: true, data: 1 })).type).toBe('tool_result');
    expect(() => parseClientFrame(JSON.stringify({ ...base, ok: true, error: { code: 'x', message: 'm' } }))).toThrow();
    expect(() => parseClientFrame(JSON.stringify({ ...base, ok: false }))).toThrow();
    expect(() => parseClientFrame(JSON.stringify({ ...base, ok: false, data: 1, error: { code: 'x', message: 'm' } }))).toThrow();
  });
  it('server frames parse and a hello is not a server frame', () => {
    const req = { type: 'tool_request', id: 'r', sessionId: 's', connectionId: 'c', tool: 'browser_state', args: {} };
    expect(parseServerFrame(JSON.stringify(req)).type).toBe('tool_request');
    expect(() => parseServerFrame(JSON.stringify(hello))).toThrow(ProtocolError);
  });
  it('the schema itself is exported for consumers', () => {
    expect(ClientHelloSchema.safeParse(hello).success).toBe(true);
  });
});

describe('32 MiB message limit', () => {
  it('is 33,554,432 bytes', () => expect(MAX_MESSAGE_BYTES).toBe(33_554_432));
  it('allows the exact limit and rejects limit + 1', () => {
    expect(() => assertWithinMessageLimit(MAX_MESSAGE_BYTES)).not.toThrow();
    expect(() => assertWithinMessageLimit(MAX_MESSAGE_BYTES + 1)).toThrowError(
      expect.objectContaining({ code: 'payload_too_large' }),
    );
  });
  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('𝄞')).toBe(4);
    expect(utf8ByteLength('\ud800')).toBe(3);
    expect(utf8ByteLength('ñandú ✓ 𝄞')).toBe(Buffer.byteLength('ñandú ✓ 𝄞'));
  });
  it('checks size BEFORE parsing: oversize text is refused even if it is not JSON', () => {
    expect(() => parseClientFrame('{', MAX_MESSAGE_BYTES + 1)).toThrowError(
      expect.objectContaining({ code: 'payload_too_large' }),
    );
  });
  it('a multibyte message under the char count but over the byte count is oversize', () => {
    // 11,184,811 x "€" = 33,554,433 bytes (limit + 1) in only 11.2M chars.
    const text = '€'.repeat(11_184_811);
    expect(text.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(utf8ByteLength(text)).toBe(MAX_MESSAGE_BYTES + 1);
    expect(() => parseClientFrame(text)).toThrowError(expect.objectContaining({ code: 'payload_too_large' }));
  });
  it('serializeFrame refuses an oversize outbound frame before send', () => {
    const big = { type: 'tool_request', id: 'r', sessionId: 's', connectionId: 'c', tool: 't', args: { blob: 'x'.repeat(MAX_MESSAGE_BYTES) } } as const;
    expect(() => serializeFrame(big)).toThrowError(expect.objectContaining({ code: 'payload_too_large' }));
  });
});
