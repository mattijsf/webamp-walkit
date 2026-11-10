// SPDX-License-Identifier: GPL-3.0-or-later

// Decodes the pictures a skin holds, as the trace host wants them: PNG (every color type at
// 8 bits, and 1, 2 and 4 bit greys and palettes; 16 bits scaled down), BMP (1, 4, 8, 24 and
// 32 bits, RLE4 and RLE8, bottom-up or top-down) and GIF (the first frame), as ARGB rows top
// first, the same values walkit-trace's decoder gives on a desktop. JPEG is `null`: the skins hold a
// few as album art placeholders, which no scenario draws.

/** {w, h, argb: Uint32Array} of `bytes`, or null. `inflate(bytes)` undoes zlib. */
export async function decodePicture(bytes, inflate) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    try {
      return await decodePng(bytes, inflate);
    } catch {
      return null;
    }
  }
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    try {
      return decodeBmp(bytes);
    } catch {
      return null;
    }
  }
  if (bytes.length > 13 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    try {
      return decodeGif(bytes);
    } catch {
      return null;
    }
  }
  return null;
}

async function decodePng(bytes, inflate) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let w = 0;
  let h = 0;
  let depth = 8;
  let ctype = 6;
  let interlace = 0;
  const idat = [];
  let palette = null;
  let trns = null;
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at, false);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      w = view.getUint32(at + 8, false);
      h = view.getUint32(at + 12, false);
      depth = bytes[at + 16];
      ctype = bytes[at + 17];
      interlace = bytes[at + 20];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (interlace !== 0) return null;
  const total = idat.reduce((n, d) => n + d.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const d of idat) {
    joined.set(d, o);
    o += d.length;
  }
  const raw = await inflate(joined);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const bpp = Math.max(1, Math.floor((channels * depth) / 8));
  const stride = Math.ceil((w * channels * depth) / 8);
  const rows = new Uint8Array(stride * h);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = rows.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  const argb = new Uint32Array(w * h);
  const sample = (row, i) => {
    // the i-th sample of a row at the bit depth, scaled to 8 bits
    if (depth === 8) return row[i];
    if (depth === 16) return row[i * 2];
    const perByte = 8 / depth;
    const byte = row[Math.floor(i / perByte)];
    const shift = 8 - depth * (1 + (i % perByte));
    const v = (byte >> shift) & ((1 << depth) - 1);
    return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < h; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      let r;
      let g;
      let b;
      let a = 255;
      if (ctype === 0) {
        r = g = b = sample(row, x);
        if (trns && trns.length >= 2) {
          const key = depth === 16 ? trns[0] : (trns[1] * 255) / ((1 << depth) - 1);
          if (Math.round(key) === r) a = 0;
        }
      } else if (ctype === 2) {
        r = sample(row, x * 3);
        g = sample(row, x * 3 + 1);
        b = sample(row, x * 3 + 2);
        if (trns && trns.length >= 6) {
          const k = depth === 16 ? [trns[0], trns[2], trns[4]] : [trns[1], trns[3], trns[5]];
          if (k[0] === r && k[1] === g && k[2] === b) a = 0;
        }
      } else if (ctype === 3) {
        const i = sample(row, x);
        r = palette ? palette[i * 3] : 0;
        g = palette ? palette[i * 3 + 1] : 0;
        b = palette ? palette[i * 3 + 2] : 0;
        if (trns && i < trns.length) a = trns[i];
      } else if (ctype === 4) {
        r = g = b = sample(row, x * 2);
        a = sample(row, x * 2 + 1);
      } else {
        r = sample(row, x * 4);
        g = sample(row, x * 4 + 1);
        b = sample(row, x * 4 + 2);
        a = sample(row, x * 4 + 3);
      }
      argb[y * w + x] = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
    }
  }
  return { w, h, argb };
}

function decodeBmp(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(10, true);
  const headerSize = view.getUint32(14, true);
  const w = view.getInt32(18, true);
  const hh = view.getInt32(22, true);
  const bits = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const h = Math.abs(hh);
  const bottomUp = hh > 0;
  const argb = new Uint32Array(w * h);
  const put = (x, row, v) => {
    const y = bottomUp ? h - 1 - row : row;
    if (x >= 0 && x < w && y >= 0 && y < h) argb[y * w + x] = v >>> 0;
  };
  if (bits <= 8) {
    // the palette, BGRA, after the header; a palette entry is opaque
    let colors = view.getUint32(46, true) || 1 << bits;
    colors = Math.min(colors, 1 << bits);
    const pal = new Uint32Array(1 << bits);
    const palAt = 14 + headerSize;
    for (let i = 0; i < colors; i++) {
      const p = palAt + i * 4;
      pal[i] = ((0xff << 24) | (bytes[p + 2] << 16) | (bytes[p + 1] << 8) | bytes[p]) >>> 0;
    }
    if (compression === 1 || compression === 2) {
      // RLE8 / RLE4: runs of one index, and literal stretches; rows start at the bottom
      let p = offset;
      let x = 0;
      let row = 0;
      const nibbles = compression === 2;
      while (p + 1 < bytes.length && row < h) {
        const count = bytes[p];
        const val = bytes[p + 1];
        p += 2;
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            const idx = nibbles ? (i % 2 === 0 ? val >> 4 : val & 0xf) : val;
            put(x++, row, pal[idx]);
          }
        } else if (val === 0) {
          x = 0;
          row++;
        } else if (val === 1) {
          break;
        } else if (val === 2) {
          x += bytes[p];
          row += bytes[p + 1];
          p += 2;
        } else {
          const n = val;
          for (let i = 0; i < n; i++) {
            const idx = nibbles ? ((bytes[p + (i >> 1)] >> (i % 2 === 0 ? 4 : 0)) & 0xf) : bytes[p + i];
            put(x++, row, pal[idx]);
          }
          const used = nibbles ? (n + 1) >> 1 : n;
          p += used + (used % 2);
        }
      }
      return { w, h, argb };
    }
    if (compression !== 0) return null;
    const stride = Math.floor((w * bits + 31) / 32) * 4;
    for (let row = 0; row < h; row++) {
      const src = offset + row * stride;
      for (let x = 0; x < w; x++) {
        const bit = x * bits;
        const byte = bytes[src + (bit >> 3)];
        const idx = bits === 8 ? byte : (byte >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
        put(x, row, pal[idx]);
      }
    }
    return { w, h, argb };
  }
  if (bits !== 24 && bits !== 32) return null;
  if (compression !== 0 && compression !== 3) return null;
  const stride = Math.floor((w * bits + 31) / 32) * 4;
  for (let row = 0; row < h; row++) {
    const src = offset + row * stride;
    for (let x = 0; x < w; x++) {
      const p = src + x * (bits / 8);
      const a = bits === 32 ? bytes[p + 3] : 255;
      put(x, row, (a << 24) | (bytes[p + 2] << 16) | (bytes[p + 1] << 8) | bytes[p]);
    }
  }
  return { w, h, argb };
}

/** The first frame of a GIF: LZW undone, the palette applied, the transparent index at alpha 0. */
function decodeGif(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sw = view.getUint16(6, true);
  const sh = view.getUint16(8, true);
  const flags = bytes[10];
  let p = 13;
  let globalPal = null;
  if (flags & 0x80) {
    const n = 1 << ((flags & 7) + 1);
    globalPal = bytes.subarray(p, p + n * 3);
    p += n * 3;
  }
  let transparent = -1;
  const argb = new Uint32Array(sw * sh);
  while (p < bytes.length) {
    const b = bytes[p++];
    if (b === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9) {
        const size = bytes[p];
        const gflags = bytes[p + 1];
        if (gflags & 1) transparent = bytes[p + 4];
        p += size + 1;
      }
      while (bytes[p] !== 0) p += bytes[p] + 1;
      p++;
    } else if (b === 0x2c) {
      const ix = view.getUint16(p, true);
      const iy = view.getUint16(p + 2, true);
      const iw = view.getUint16(p + 4, true);
      const ih = view.getUint16(p + 6, true);
      const iflags = bytes[p + 8];
      p += 9;
      let pal = globalPal;
      if (iflags & 0x80) {
        const n = 1 << ((iflags & 7) + 1);
        pal = bytes.subarray(p, p + n * 3);
        p += n * 3;
      }
      const interlaced = (iflags & 0x40) !== 0;
      const minCode = bytes[p++];
      const data = [];
      while (bytes[p] !== 0) {
        data.push(bytes.subarray(p + 1, p + 1 + bytes[p]));
        p += bytes[p] + 1;
      }
      p++;
      const joined = new Uint8Array(data.reduce((n, d) => n + d.length, 0));
      let o = 0;
      for (const d of data) {
        joined.set(d, o);
        o += d.length;
      }
      const indices = lzw(joined, minCode, iw * ih);
      const rowOrder = [];
      if (interlaced) {
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < ih; y += step) rowOrder.push(y);
      } else for (let y = 0; y < ih; y++) rowOrder.push(y);
      for (let r = 0; r < ih; r++) {
        const y = rowOrder[r];
        for (let x = 0; x < iw; x++) {
          const idx = indices[r * iw + x];
          const px = ix + x;
          const py = iy + y;
          if (px >= sw || py >= sh || idx === undefined) continue;
          const a = idx === transparent ? 0 : 255;
          const c = pal && idx * 3 + 2 < pal.length ? (pal[idx * 3] << 16) | (pal[idx * 3 + 1] << 8) | pal[idx * 3 + 2] : 0;
          argb[py * sw + px] = ((a << 24) | c) >>> 0;
        }
      }
      return { w: sw, h: sh, argb };
    } else if (b === 0x3b) break;
    else break;
  }
  return { w: sw, h: sh, argb };
}

/** GIF's LZW: `data` at `minCode` bits, `count` indices out. */
function lzw(data, minCode, count) {
  const out = new Uint8Array(count);
  const clear = 1 << minCode;
  const end = clear + 1;
  let codeSize = minCode + 1;
  let next = end + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Int32Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
  }
  let bitBuf = 0;
  let bitCount = 0;
  let pos = 0;
  let o = 0;
  let prev = -1;
  const emit = (code) => {
    const len = length[code];
    let c = code;
    for (let i = len - 1; i >= 0; i--) {
      if (o + i < count) out[o + i] = suffix[c];
      c = prefix[c];
    }
    o += len;
  };
  const first = (code) => {
    let c = code;
    while (prefix[c] >= 0) c = prefix[c];
    return suffix[c];
  };
  while (o < count) {
    while (bitCount < codeSize && pos < data.length) {
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    if (bitCount < codeSize) break;
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>>= codeSize;
    bitCount -= codeSize;
    if (code === clear) {
      codeSize = minCode + 1;
      next = end + 1;
      prev = -1;
      continue;
    }
    if (code === end) break;
    if (prev < 0) {
      emit(code);
      prev = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = first(code);
        length[next] = length[prev] + 1;
        next++;
      }
    } else {
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = first(prev);
        length[next] = length[prev] + 1;
        next++;
      }
      emit(code);
    }
    if (next === 1 << codeSize && codeSize < 12) codeSize++;
    prev = code;
  }
  return out;
}
