// Copyright (C) 2026 Piers Finlayson <piers@piers.rocks>
//
// MIT License

// MD5, RFC 1321. esptool-js compares it with the MD5 the ROM loader
// computes over each file written. crypto.subtle doesn't have MD5.

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));

// Returns the MD5 of bytes as lowercase hex.
export function md5Hex(bytes) {
  const padded = new Uint8Array(((bytes.length + 8) >> 6) + 1 << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const v = new DataView(padded.buffer);
  v.setUint32(padded.length - 8, (bytes.length * 8) >>> 0, true);
  v.setUint32(padded.length - 4, Math.floor(bytes.length / 0x20000000), true);

  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const m = new Uint32Array(16);
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) m[i] = v.getUint32(o + 4 * i, true);
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      let f, g;
      if (round === 0) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (round === 1) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (round === 2) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const s = S[round * 4 + (i & 3)];
      const x = (a + f + K[i] + m[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
  }
  const out = new DataView(new ArrayBuffer(16));
  h.forEach((word, i) => out.setUint32(4 * i, word, true));
  return Array.from(new Uint8Array(out.buffer), (x) => x.toString(16).padStart(2, '0')).join('');
}
