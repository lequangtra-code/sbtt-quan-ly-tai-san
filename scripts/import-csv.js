// Nhập tài sản từ file CSV vào CSDL thật bằng đúng quy trình của chức năng "Nhập từ file" (có kiểm tra từng dòng).
// Cách dùng: node scripts/import-csv.js <file.csv> [--commit]   (không có --commit = chỉ chạy thử, không lưu)
// Thao tác được ghi nhật ký dưới tên tài khoản quản trị (ADMIN_EMAIL trong .env).
import fs from 'node:fs';
import { config } from '../server/config.js';
import { db, createSql, setDefaultSql } from '../server/db.js';
import { randomToken, sha256 } from '../server/security.js';
import { createApp } from '../server/app.js';
import http from 'node:http';

// Gọi API nội bộ không giới hạn thời gian chờ (nhập nhiều dòng có thể mất vài phút)
const post = (port, path, cookie, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', timeout: 0,
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-SBTT': '1', cookie } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  req.on('error', reject); req.end(data);
});

const [file, flag] = process.argv.slice(2);
if (!file || !config.databaseUrl) { console.error('Cách dùng: node scripts/import-csv.js <file.csv> [--commit]  (cần DATABASE_URL trong .env)'); process.exit(1); }
const sql = createSql(config.databaseUrl, { max: 3 });
setDefaultSql(sql);
const token = randomToken(32);
let server, admin;
try {
  admin = await db.get('SELECT id, email, must_change_password FROM users WHERE email = ?', config.adminEmail.toLowerCase());
  if (!admin) throw new Error('Không tìm thấy tài khoản ' + config.adminEmail);
  await db.run("INSERT INTO sessions(token_hash, user_id, expires_at, ip, method) VALUES (?,?,datetime('now','+30 minutes'),'127.0.0.1','script')", sha256(token), admin.id);
  if (admin.must_change_password) await db.run('UPDATE users SET must_change_password = 0 WHERE id = ?', admin.id);
  ({ server } = createApp({ serveStatic: false }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  const { status, json: res } = await post(server.address().port, '/api/assets/import', 'sbtt_sid=' + token,
    { csv: fs.readFileSync(file, 'utf8'), dry_run: flag !== '--commit' });
  console.log(JSON.stringify({ http: status, seconds: Math.round((Date.now() - t0) / 1000), mode: flag === '--commit' ? 'LƯU THẬT' : 'chạy thử', created: res.created, updated: res.updated, committed: res.committed, errors: res.errors?.length, error: res.error }));
  for (const e of res.errors || []) console.log('  dòng', e.line, ':', e.error);
} finally {
  if (admin?.must_change_password) await db.run('UPDATE users SET must_change_password = 1 WHERE id = ?', admin.id).catch(() => {});
  await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token)).catch(() => {});
  server?.close();
  await sql.end();
}
