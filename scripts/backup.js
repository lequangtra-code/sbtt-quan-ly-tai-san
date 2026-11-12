// Sao lưu toàn bộ dữ liệu ra file JSON: npm run backup  -> backup/sbtt-asset-YYYYMMDD-HHMM.json
// (Supabase cũng tự sao lưu hằng ngày; file này dùng để lưu thêm 1 bản ở Google Drive/NAS.)
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../server/config.js';
import { createSql } from '../server/db.js';

const TABLES = ['permissions', 'roles', 'role_permissions', 'locations', 'users', 'user_locations', 'user_permission_overrides',
  'asset_categories', 'assets', 'incidents', 'maintenance_records', 'transfers', 'audit_logs', 'settings'];

if (!config.databaseUrl) { console.error('Thiếu DATABASE_URL trong .env'); process.exit(1); }
const sql = createSql(config.databaseUrl, { max: 1 });
const dir = path.join(ROOT, 'backup');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
const out = path.join(dir, `sbtt-asset-${stamp}.json`);
try {
  const data = { created_at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) data.tables[t] = [...await sql.unsafe(`SELECT * FROM ${t}`)];
  fs.writeFileSync(out, JSON.stringify(data));
  console.log('Đã sao lưu:', out);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, -30)) fs.unlinkSync(path.join(dir, f)); // giữ 30 bản gần nhất
} finally {
  await sql.end();
}
