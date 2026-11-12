// Lớp truy cập CSDL PostgreSQL (Supabase) – dùng chung cho Node.js và Cloudflare Workers.
// - Câu SQL viết với dấu ? như trước, được đổi sang $1, $2... tự động.
// - Mỗi request dùng 1 kết nối riêng (Workers không cho dùng chung kết nối giữa các request);
//   kết nối hiện hành được giữ trong AsyncLocalStorage nên mã nghiệp vụ chỉ cần gọi db.get/all/run.
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import { randomToken } from './security.js';

const als = new AsyncLocalStorage();
let defaultSql = null;

/** Tạo client postgres.js. COUNT/SUM (int8) trả về số JS thay vì chuỗi. */
export function createSql(url, opts = {}) {
  return postgres(url, {
    max: 5,
    fetch_types: false,
    onnotice: () => {},
    types: { int8: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) } },
    ...opts,
  });
}

/** Đặt kết nối mặc định (Node.js chạy lâu dài, kiểm thử, script). */
export function setDefaultSql(sql) { defaultSql = sql; }

/** Chạy fn với 1 kết nối riêng (dùng cho mỗi request trên Workers). */
export function withSql(sql, fn) { return als.run({ sql, depth: 0 }, fn); }

const current = () => {
  const s = als.getStore();
  if (s) return s;
  if (!defaultSql) throw new Error('Chưa cấu hình kết nối CSDL (DATABASE_URL / HYPERDRIVE)');
  return { sql: defaultSql, depth: 0 };
};

/** Đổi ? -> $n (bỏ qua ? nằm trong chuỗi '...') */
const cache = new Map();
export function toPg(text) {
  let out = cache.get(text);
  if (out) return out;
  let n = 0, q = false;
  out = '';
  for (const ch of text) {
    if (ch === "'") q = !q;
    out += !q && ch === '?' ? '$' + ++n : ch;
  }
  if (/^\s*INSERT\b/i.test(out) && !/\bRETURNING\b/i.test(out)) out += ' RETURNING *';
  if (cache.size < 2000) cache.set(text, out);
  return out;
}

const norm = (v) => (v === true ? 1 : v === false ? 0 : v === undefined ? null : v);

async function query(text, params) {
  const { sql } = current();
  return sql.unsafe(toPg(text), params.map(norm));
}

export const db = {
  async get(text, ...params) { return (await query(text, params))[0]; },
  async all(text, ...params) { return [...(await query(text, params))]; },
  async run(text, ...params) {
    const r = await query(text, params);
    return { changes: r.count, lastInsertRowid: r[0]?.id ?? null };
  },
  async exec(text) { const { sql } = current(); return sql.unsafe(text); },
  hashPassword: async (pw) => (await db.get('SELECT sbtt_hash_password(?) AS h', String(pw))).h,
  verifyPassword: async (pw, stored) => !!stored && (await db.get('SELECT sbtt_check_password(?, ?) AS ok', String(pw), stored)).ok,
};

export class Rollback extends Error { constructor(value) { super('rollback'); this.value = value; } }

/**
 * Giao dịch: tx(db, async () => {...}). Lồng nhau -> dùng SAVEPOINT.
 * Ném new Rollback(value) để huỷ giao dịch mà vẫn trả về value.
 */
export async function tx(_db, fn) {
  const store = current();
  const run = (sql) => als.run({ sql, depth: store.depth + 1 }, fn);
  try {
    return store.depth === 0 && typeof store.sql.begin === 'function'
      ? await store.sql.begin(run)
      : await store.sql.savepoint(run);
  } catch (e) {
    if (e instanceof Rollback) return e.value;
    throw e;
  }
}

export function normalizePhone(p) {
  if (!p) return null;
  let s = String(p).replace(/[^\d+]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (s.startsWith('84') && s.length === 11) s = '0' + s.slice(2);
  return /^0\d{9,10}$/.test(s) ? s : null;
}

export async function newQrToken() {
  for (;;) {
    const t = randomToken(8).replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
    if (t.length >= 8 && !(await db.get('SELECT 1 AS x FROM assets WHERE qr_token=?', t))) return t;
  }
}

/** Sinh mã tài sản theo quy ước công ty: [Mã CH]-[Mã nhóm]-[Năm 2 số]-[STT 5 số], VD S08-DL-26-00001 */
export async function nextAssetCode(_db, categoryCode, locationCode) {
  const yy = new Date(Date.now() + 7 * 3600e3).toISOString().slice(2, 4);
  const base = `${locationCode}-${categoryCode}-${yy}-`;
  let max = 0;
  for (const r of await db.all('SELECT asset_code FROM assets WHERE asset_code LIKE ?', base + '%')) {
    const m = r.asset_code.slice(base.length).match(/^(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return base + String(max + 1).padStart(5, '0');
}
