// @ts-check
// Source decoding (design 6.1 / 6.3 step 1): BOM first, then (HTML only) a <meta charset> prescan of the first
// 1024 bytes, else UTF-8. The BOM is consumed (not part of the text), matching the store's decodeText() so that
// offsets agree with store.readWorking().text / readVersion().source; unknown labels fall back to UTF-8.
// Strings are used as given (a leading U+FEFF in a string is kept).

/**
 * @param {Uint8Array} buf
 * @returns {string|null}
 */
export function sniffBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  return null;
}

/**
 * Charset declared by a <meta charset> / <meta http-equiv content="...; charset=..."> in the first 1024 bytes.
 * @param {Uint8Array} buf
 * @returns {string|null}
 */
export function prescanMetaCharset(buf) {
  const head = Buffer.from(buf.subarray(0, 1024)).toString('latin1');
  const re = /<meta\b[^>]*?charset\s*=\s*["']?\s*([A-Za-z0-9_:.+-]+)/gi;
  const m = re.exec(head);
  if (!m) return null;
  const label = m[1].toLowerCase();
  // HTML: a meta-declared UTF-16 means UTF-8 (the bytes were not UTF-16 or there would be a BOM)
  if (label.startsWith('utf-16')) return 'utf-8';
  if (label === 'x-user-defined') return 'windows-1252';
  return label;
}

/**
 * Decode a document.
 * @param {string|Uint8Array} input
 * @param {'markdown'|'html'|string} [format]
 * @returns {{ text: string, charset: string, bom: boolean }}
 */
export function decodeSource(input, format = 'html') {
  if (typeof input === 'string') return { text: input, charset: 'utf-8', bom: input.charCodeAt(0) === 0xfeff };
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const bomCharset = sniffBom(buf);
  let charset = bomCharset || (format === 'html' ? prescanMetaCharset(buf) : null) || 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    charset = 'utf-8';
    decoder = new TextDecoder('utf-8');
  }
  // TextDecoder strips a BOM matching its own encoding; strip any BOM bytes we sniffed explicitly.
  const body = bomCharset ? buf.subarray(bomCharset === 'utf-8' ? 3 : 2) : buf;
  return { text: decoder.decode(body), charset: decoder.encoding, bom: Boolean(bomCharset) };
}
