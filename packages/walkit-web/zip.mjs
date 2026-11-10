// SPDX-License-Identifier: GPL-3.0-or-later

// Reads a zip (a `.wal`) from bytes: stored and deflated entries, through the inflater the
// host gives (node's zlib, or a DecompressionStream). Nothing is written.

/** The entries of `bytes`: a Map of name -> Uint8Array. `inflateRaw(bytes)` undoes deflate. */
export function unzip(bytes, inflateRaw) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // the end of central directory record, searched from the end
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const csize = view.getUint32(at + 20, true);
    const usize = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lnameLen = view.getUint16(local + 26, true);
    const lextraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lnameLen + lextraLen;
    const data = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, data);
    else if (method === 8) {
      const inflated = inflateRaw(data);
      if (inflated instanceof Promise || inflated.length === usize) out.set(name, inflated);
    }
  }
  return out;
}

/**
 * The entries of `bytes` as [unzip] gives them, with `inflateRaw(bytes)` giving a Promise (a
 * page's DecompressionStream): for a `.wal` dropped on a page.
 */
export async function unzipAsync(bytes, inflateRaw) {
  const pending = [];
  const out = unzip(bytes, (data) => {
    const p = inflateRaw(data);
    pending.push(p);
    return p;
  });
  // deflated entries came back as promises; stored ones as bytes
  const resolved = new Map();
  for (const [name, data] of out) resolved.set(name, data instanceof Promise ? await data : data);
  return resolved;
}
