// Bộ mã hoá QR Code thuần JavaScript (không phụ thuộc thư viện ngoài).
// Hỗ trợ: chế độ Byte (UTF-8), phiên bản 1–10, mức sửa lỗi L/M/Q/H, tự chọn mask.
// Đầu ra: ma trận boolean hoặc chuỗi SVG.

const ECL = { L: { bits: 1, i: 0 }, M: { bits: 0, i: 1 }, Q: { bits: 3, i: 2 }, H: { bits: 2, i: 3 } };

// [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] theo version (1..10) x ECL (L,M,Q,H)
const EC_TABLE = [
  null,
  [[7, 1, 19], [10, 1, 16], [13, 1, 13], [17, 1, 9]],
  [[10, 1, 34], [16, 1, 28], [22, 1, 22], [28, 1, 16]],
  [[15, 1, 55], [26, 1, 44], [18, 2, 17], [22, 2, 13]],
  [[20, 1, 80], [18, 2, 32], [26, 2, 24], [16, 4, 9]],
  [[26, 1, 108], [24, 2, 43], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
  [[18, 2, 68], [16, 4, 27], [24, 4, 19], [28, 4, 15]],
  [[20, 2, 78], [18, 4, 31], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
  [[24, 2, 97], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
  [[30, 2, 116], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
  [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

// ---- Reed–Solomon trên GF(256), đa thức 0x11D ----
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) { next[j] ^= poly[j]; next[j + 1] ^= gmul(poly[j], EXP[i]); }
    poly = next;
  }
  return poly; // hệ số bậc cao -> thấp, poly[0] = 1
}
export function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gmul(gen[i + 1], factor);
  }
  return res;
}

function dataCapacity(ver, ecl) {
  const [, b1, d1, b2 = 0, d2 = 0] = EC_TABLE[ver][ECL[ecl].i];
  return b1 * d1 + b2 * d2;
}

function buildCodewords(bytes, ver, ecl) {
  const cap = dataCapacity(ver, ecl);
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecLen, b1, d1, b2 = 0, d2 = 0] = EC_TABLE[ver][ECL[ecl].i];
  const blocks = [];
  let k = 0;
  for (let i = 0; i < b1; i++) { const d = data.slice(k, k + d1); k += d1; blocks.push({ d, e: rsEncode(d, ecLen) }); }
  for (let i = 0; i < b2; i++) { const d = data.slice(k, k + d2); k += d2; blocks.push({ d, e: rsEncode(d, ecLen) }); }
  const out = [];
  const maxD = Math.max(d1, d2);
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

function makeMatrix(ver) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => { m[y][x] = v; fn[y][x] = true; };
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  for (let i = 0; i < size; i++) { if (!fn[6][i]) set(i, 6, i % 2 === 0); if (!fn[i][6]) set(6, i, i % 2 === 0); }
  const al = ALIGN[ver];
  for (const ay of al) for (const ax of al) {
    if ((ax === 6 && ay === 6) || (ax === 6 && ay === al[al.length - 1]) || (ax === al[al.length - 1] && ay === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // giữ chỗ vùng format + dark module
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(i, 8, false); if (!fn[i][8]) set(8, i, false); }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, false); set(8, size - 1 - i, false); }
  set(8, size - 8, true);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }
  return { m, fn, size };
}

function placeData(m, fn, size, codewords, ver) {
  const bits = [];
  for (const c of codewords) for (let i = 7; i >= 0; i--) bits.push((c >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[ver]; i++) bits.push(0);
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && idx < bits.length) { m[y][x] = bits[idx] === 1; idx++; }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, fn, size, mask) {
  const f = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && f(x, y)) m[y][x] = !m[y][x];
}

function drawFormat(m, size, ecl, mask) {
  const data = (ECL[ecl].bits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = true;
}

function penalty(m, size) {
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
      for (let b = 0; b + 10 < size; b++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(a, b + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  line((a, b) => m[a][b]);
  line((a, b) => m[b][a]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return p;
}

export function encodeQR(text, ecl = 'M', forceMask = -1) {
  const bytes = [...new TextEncoder().encode(String(text))]; // UTF-8, chạy được cả trình duyệt lẫn Node
  let ver = 0;
  for (let v = 1; v <= 10; v++) {
    const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (need <= dataCapacity(v, ecl) * 8) { ver = v; break; }
  }
  if (!ver) throw new Error('Nội dung quá dài cho QR (tối đa phiên bản 10)');
  const codewords = buildCodewords(bytes, ver, ecl);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask >= 0 && mask !== forceMask) continue;
    const { m, fn, size } = makeMatrix(ver);
    placeData(m, fn, size, codewords, ver);
    applyMask(m, fn, size, mask);
    drawFormat(m, size, ecl, mask);
    const score = penalty(m, size);
    if (!best || score < best.score) best = { m, size, score, ver, mask };
  }
  return best;
}

export function qrSvg(text, { ecl = 'M', margin = 4, scale = 4, color = '#000', bg = '#fff' } = {}) {
  const { m, size } = encodeQR(text, ecl);
  const dim = size + margin * 2;
  let path = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) path += `M${x + margin} ${y + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim * scale}" height="${dim * scale}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${bg}"/><path d="${path}" fill="${color}"/></svg>`;
}
