import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

/**
 * Compact blob codec used for every JSON payload we persist.
 *
 * Format (1 byte header + body):
 *   0x00  raw UTF-8 JSON      (used when the payload is tiny or compression doesn't help)
 *   0x01  brotli(UTF-8 JSON)
 *
 * The header lets us change strategy later without a data migration, and means small
 * payloads never pay the brotli overhead.
 */
const RAW = 0;
const BROTLI = 1;
const MIN_COMPRESS_BYTES = 96;
const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024; // zip-bomb guard

export function createCodec({ level = 5 } = {}) {
  const params = (size) => ({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: level,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: size,
    },
  });

  /** @param {unknown} value JSON-serialisable @returns {Buffer} */
  function pack(value) {
    const json = Buffer.from(JSON.stringify(value), 'utf8');
    if (json.length >= MIN_COMPRESS_BYTES) {
      const z = brotliCompressSync(json, params(json.length));
      if (z.length + 1 < json.length + 1) return Buffer.concat([Buffer.from([BROTLI]), z]);
    }
    return Buffer.concat([Buffer.from([RAW]), json]);
  }

  /** @param {Buffer|Uint8Array|null|undefined} blob @returns {any} */
  function unpack(blob) {
    if (blob == null) return null;
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    if (buf.length === 0) return null;
    const body = buf.subarray(1);
    switch (buf[0]) {
      case RAW:
        return JSON.parse(body.toString('utf8'));
      case BROTLI:
        return JSON.parse(brotliDecompressSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8'));
      default:
        throw new Error(`Unknown blob format 0x${buf[0].toString(16)}`);
    }
  }

  return { pack, unpack };
}
