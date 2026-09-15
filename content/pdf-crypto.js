/* Helpers for reading PDFs that do not hand over their text willingly.

   Two situations come up with supplier invoices:

   1. The file is encrypted. Carriers often protect an invoice against editing,
      which also encrypts every stream in it. The password is empty, so the file
      opens anywhere, but the bytes have to be decrypted before they can be
      inflated. The standard security handler is implemented here: RC4 for the
      older revisions and AES-CBC for the newer ones.

   2. The fonts are Identity-H. The text then holds glyph numbers instead of
      characters - <0048 0065> rather than "He". Every such font carries a
      /ToUnicode table saying which glyph is which character, so that table is
      read and applied.

   Both are implemented with what the browser already provides; only MD5 is not
   available natively and is included below. */

const FitonPdf = (() => {
  'use strict';

  /* ---------------------------------------------------------------- MD5 --
     WebCrypto deliberately omits MD5, but the PDF standard security handler
     is defined in terms of it, so there is no way around a small version. */
  function md5(bytes) {
    const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
               5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
               4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
               6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

    const ml = bytes.length;
    const withPadding = new Uint8Array((((ml + 8) >> 6) + 1) << 6);
    withPadding.set(bytes);
    withPadding[ml] = 0x80;
    const bitLen = ml * 8;
    new DataView(withPadding.buffer).setUint32(withPadding.length - 8, bitLen >>> 0, true);
    new DataView(withPadding.buffer).setUint32(withPadding.length - 4, Math.floor(bitLen / 4294967296), true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const view = new DataView(withPadding.buffer);
    const rotl = (x, c) => (x << c) | (x >>> (32 - c));

    for (let chunk = 0; chunk < withPadding.length; chunk += 64) {
      const M = new Uint32Array(16);
      for (let i = 0; i < 16; i++) M[i] = view.getUint32(chunk + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16)      { F = (B & C) | (~B & D);          g = i; }
        else if (i < 32) { F = (D & B) | (~D & C);          g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D;                   g = (3 * i + 5) % 16; }
        else             { F = C ^ (B | ~D);                g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, s[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }

    const out = new Uint8Array(16);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, a0, true); dv.setUint32(4, b0, true);
    dv.setUint32(8, c0, true); dv.setUint32(12, d0, true);
    return out;
  }

  /* ---------------------------------------------------------------- RC4 -- */
  function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    for (let i = 0, j = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 0xff;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) {
      i = (i + 1) & 0xff;
      j = (j + S[i]) & 0xff;
      const t = S[i]; S[i] = S[j]; S[j] = t;
      out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
    }
    return out;
  }

  /* The 32-byte padding every standard-security PDF starts its key from. */
  const PAD = new Uint8Array([
    0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
    0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A
  ]);

  const concat = arrays => {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    arrays.forEach(a => { out.set(a, at); at += a.length; });
    return out;
  };

  const latin1Bytes = str => {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  };

  const hexBytes = hex => {
    const clean = hex.replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(clean.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  };

  /* A PDF string literal: (text) with escapes, or <hex>. */
  function pdfStringBytes(raw) {
    if (!raw) return new Uint8Array(0);
    if (raw[0] === '<') return hexBytes(raw);
    let body = raw.slice(1, -1), out = [];
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c !== '\\') { out.push(body.charCodeAt(i) & 0xff); continue; }
      const next = body[++i];
      const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (simple[next] !== undefined) { out.push(simple[next]); continue; }
      if (/[0-7]/.test(next)) {
        let oct = next;
        while (oct.length < 3 && /[0-7]/.test(body[i + 1] || '')) oct += body[++i];
        out.push(parseInt(oct, 8) & 0xff);
        continue;
      }
      out.push(body.charCodeAt(i) & 0xff);
    }
    return new Uint8Array(out);
  }

  /* ------------------------------------------------------- encryption -- */
  function readEncryption(text) {
    const ref = /\/Encrypt\s+(\d+)\s+(\d+)\s+R/.exec(text);
    if (!ref) return null;

    const objRe = new RegExp('(?:^|[^0-9])' + ref[1] + '\\s+' + ref[2] + '\\s+obj([\\s\\S]{0,1200}?)endobj');
    const obj = objRe.exec(text);
    if (!obj) return null;
    const dict = obj[1];

    const num = (key, fallback) => {
      const m = new RegExp('\\/' + key + '\\s+(-?\\d+)').exec(dict);
      return m ? parseInt(m[1], 10) : fallback;
    };
    const str = key => {
      const m = new RegExp('\\/' + key + '\\s*(\\([\\s\\S]*?\\)|<[0-9A-Fa-f\\s]*>)').exec(dict);
      return m ? m[1] : '';
    };

    const idMatch = /\/ID\s*\[\s*(<[0-9A-Fa-f\s]*>|\([\s\S]*?\))/.exec(text);
    const cfm = /\/CFM\s*\/(\w+)/.exec(dict);

    return {
      v: num('V', 0),
      r: num('R', 2),
      length: num('Length', 40),
      p: num('P', -1),
      o: pdfStringBytes(str('O')),
      u: pdfStringBytes(str('U')),
      id: pdfStringBytes(idMatch ? idMatch[1] : ''),
      cfm: cfm ? cfm[1] : (num('V', 0) >= 4 ? 'AESV2' : 'V2'),
      encryptMetadata: !/\/EncryptMetadata\s+false/.test(dict)
    };
  }

  /* File key for an empty user password, per the standard security handler. */
  function fileKey(enc) {
    const pBytes = new Uint8Array(4);
    new DataView(pBytes.buffer).setInt32(0, enc.p, true);

    const parts = [PAD, enc.o.slice(0, 32), pBytes, enc.id];
    if (enc.r >= 4 && !enc.encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));

    let key = md5(concat(parts));
    const keyLen = enc.r === 2 ? 5 : Math.max(5, Math.floor(enc.length / 8));
    if (enc.r >= 3) {
      for (let i = 0; i < 50; i++) key = md5(key.slice(0, keyLen));
    }
    return key.slice(0, keyLen);
  }

  function objectKey(baseKey, objNum, genNum, aes) {
    const extra = aes ? [0x73, 0x41, 0x6c, 0x54] : [];
    const data = concat([
      baseKey,
      new Uint8Array([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff,
                      genNum & 0xff, (genNum >> 8) & 0xff]),
      new Uint8Array(extra)
    ]);
    return md5(data).slice(0, Math.min(baseKey.length + 5, 16));
  }

  async function decryptStream(bytes, enc, baseKey, objNum, genNum) {
    const aes = /AESV/.test(enc.cfm);
    if (!aes) return rc4(objectKey(baseKey, objNum, genNum, false), bytes);

    // AES-128 (AESV2) uses the per-object key; AES-256 (AESV3) uses the file key.
    const key = enc.cfm === 'AESV3' ? baseKey : objectKey(baseKey, objNum, genNum, true);
    if (bytes.length <= 16) return new Uint8Array(0);
    const iv = bytes.slice(0, 16);
    const body = bytes.slice(16);
    try {
      const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, body);
      return new Uint8Array(plain);
    } catch (e) {
      return null;                       // wrong key, or a password we do not have
    }
  }

  /* --------------------------------------------------------- ToUnicode -- */
  /* Turns the CMap that ships with an Identity-H font into glyph -> text. */
  function parseCMap(content, into) {
    const map = into || new Map();

    const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let block;
    while ((block = charRe.exec(content))) {
      const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let pair;
      while ((pair = pairRe.exec(block[1]))) {
        map.set(parseInt(pair[1], 16), utf16beToString(pair[2]));
      }
    }

    const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((block = rangeRe.exec(content))) {
      const body = block[1];

      const simple = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let m;
      while ((m = simple.exec(body))) {
        const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
        const startText = utf16beToString(m[3]);
        const startCode = startText.codePointAt(0) || 0;
        for (let c = lo; c <= hi && c - lo < 65535; c++) {
          map.set(c, String.fromCodePoint(startCode + (c - lo)));
        }
      }

      const listed = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
      while ((m = listed.exec(body))) {
        const lo = parseInt(m[1], 16);
        const items = m[3].match(/<([0-9A-Fa-f]+)>/g) || [];
        items.forEach((item, i) => map.set(lo + i, utf16beToString(item.replace(/[<>]/g, ''))));
      }
    }
    return map;
  }

  function utf16beToString(hex) {
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const code = parseInt(hex.substr(i, 4), 16);
      if (!isNaN(code) && code) out += String.fromCharCode(code);
    }
    return out || ' ';
  }

  /* ------------------------------------------------------- ASCII85 -- */
  /* Some writers wrap a compressed stream in ASCII85 first, so the bytes in the
     file are printable text. Without undoing that, the stream looks like plain
     text that happens to contain the letters "Tj" - which is exactly how such a
     PDF ends up "read" but empty. */
  function ascii85Decode(bytes) {
    const out = [];
    let tuple = 0, count = 0;
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0x7e) break;                       // ~> ends the data
      if (c <= 0x20 || c === 0x0a || c === 0x0d) continue;
      if (c === 0x7a && count === 0) { out.push(0, 0, 0, 0); continue; }   // z = four zero bytes
      if (c < 0x21 || c > 0x75) continue;
      tuple = tuple * 85 + (c - 0x21);
      if (++count === 5) {
        out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
        tuple = 0; count = 0;
      }
    }
    if (count > 0) {                                // partial group at the end
      for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
      const full = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
      out.push(...full.slice(0, count - 1));
    }
    return new Uint8Array(out);
  }

  function asciiHexDecode(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      const c = String.fromCharCode(bytes[i]);
      if (c === '>') break;
      if (/[0-9A-Fa-f]/.test(c)) hex += c;
    }
    if (hex.length % 2) hex += '0';
    return hexBytes(hex);
  }

  const looksAscii85 = bytes => {
    const n = Math.min(bytes.length, 64);
    if (!n) return false;
    let printable = 0;
    for (let i = 0; i < n; i++) if (bytes[i] >= 0x21 && bytes[i] <= 0x75) printable++;
    return printable / n > 0.9;
  };

  return { md5, rc4, readEncryption, fileKey, decryptStream, parseCMap,
           latin1Bytes, hexBytes, ascii85Decode, asciiHexDecode, looksAscii85 };
})();

if (typeof module !== 'undefined') module.exports = FitonPdf;
