import { MAX_MESSAGE_BYTES } from './constants.js';
import { ProtocolError } from './errors.js';

/** UTF-8 byte length of a JS string without allocating (lone surrogates count as U+FFFD = 3 bytes). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Throws payload_too_large when a COMPLETE message exceeds the negotiated limit (exact limit is allowed). */
export function assertWithinMessageLimit(byteLength: number, limit: number = MAX_MESSAGE_BYTES): void {
  if (byteLength > limit) {
    throw new ProtocolError('payload_too_large', `message of ${byteLength} bytes exceeds the ${limit} byte limit`);
  }
}
