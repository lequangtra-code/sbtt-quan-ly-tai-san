// Tạo / cập nhật tài khoản người dùng từ danh sách nhân viên (CSV: MNV, Họ và tên, Bộ phận, Vị trí, Số điện thoại, Email).
// Cách dùng: node scripts/import-users.js <nhanvien.csv> [--commit]
//   Không có --commit: chỉ kiểm tra và in kế hoạch. Có --commit: tạo tài khoản qua API /api/users (đúng quy tắc phân quyền),
//   mật khẩu tạm của tài khoản mới được ghi ra data/mat-khau-tam-<ngày>.csv (thư mục data/ không đưa lên GitHub).
// Nhân viên đã có tài khoản (trùng mã NV) được cập nhật họ tên, chức danh, phạm vi – KHÔNG đổi mật khẩu.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { config, ROOT } from '../server/config.js';
import { db, createSql, setDefaultSql, normalizePhone } from '../server/db.js';
import { randomToken, sha256 } from '../server/security.js';
import { parseCsv, toCsv } from '../server/http.js';
import { createApp } from '../server/app.js';

const KHO = 'K02'; // kho tổng (Kho Tân Triều)

/** Quy tắc gán chức danh & phạm vi theo bộ phận / vị trí */
function mapRole(dept, pos) {
  const d = dept.toUpperCase(), p = pos.toLowerCase();
  if (/^S\d{2}$/.test(d)) return { role: 'CHT', locs: [d] };
  if (d === 'BLĐ') return { role: 'BGD', all: true };
  if (d === 'PTHT') {
    if (/giám đốc|trưởng phòng/.test(p)) return { role: 'TP_BT', all: true };
    if (/\bit\b/.test(p)) return { role: 'NV_IT', all: true };
    return { role: 'NV_BT', all: true };
  }
  if (d === 'KHO') return /trưởng/.test(p) ? { role: 'THU_KHO', locs: [KHO] } : { role: 'NV_CH', locs: [KHO] };
  if (d === 'TCKT' && /kế toán trưởng|trưởng nhóm/.test(p)) return { role: 'KT_TS', all: true };
  if (d === 'HCNS' && /giám đốc|phó phòng/.test(p)) return { role: 'HC', all: true };
  if (/công cụ dụng cụ/.test(p)) return { role: 'HC', all: true };
  if (d === 'PKD') return { role: 'QL_VUNG', all: true };
  return { role: 'NV_CH', all: true };
}

const post = (port, method, p, cookie, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 0,
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-SBTT': '1', cookie } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
  });
  req.on('error', reject); req.end(data);
});

const [file, flag] = process.argv.slice(2);
const commit = flag === '--commit';
if (!file || !config.databaseUrl) { console.error('Cách dùng: node scripts/import-users.js <nhanvien.csv> [--commit]'); process.exit(1); }

const rows = parseCsv(fs.readFileSync(file, 'utf8')).slice(1).filter((r) => (r[1] || '').trim());
const people = rows.map((r) => {
  const [code, name, dept, pos, phone, email] = r.map((x) => (x || '').trim());
  return { code: code.toUpperCase(), name, dept, pos, phoneRaw: phone, phone: normalizePhone(phone), email: email.toLowerCase() || null, ...mapRole(dept, pos) };
});
// Email dùng chung giữa nhiều người -> bỏ email, đăng nhập bằng SĐT
const emailCount = {};
for (const p of people) if (p.email) emailCount[p.email] = (emailCount[p.email] || 0) + 1;
for (const p of people) if (p.email && emailCount[p.email] > 1) { p.sharedEmail = p.email; p.email = null; }

const sql = createSql(config.databaseUrl, { max: 3 });
setDefaultSql(sql);
const token = randomToken(32);
let server, admin;
const problems = [];
try {
  admin = await db.get('SELECT * FROM users WHERE email = ?', config.adminEmail.toLowerCase());
  if (!admin) throw new Error('Không tìm thấy tài khoản quản trị ' + config.adminEmail);
  const roles = Object.fromEntries((await db.all('SELECT id, code FROM roles')).map((r) => [r.code, r.id]));
  const locs = Object.fromEntries((await db.all('SELECT id, code FROM locations')).map((l) => [l.code, l.id]));
  const existing = await db.all('SELECT id, employee_code, email, phone FROM users');
  const byCode = new Map(existing.filter((u) => u.employee_code).map((u) => [u.employee_code.toUpperCase(), u]));

  // Người trùng với tài khoản quản trị (cùng tên + là chính người quản trị) -> gắn mã NV/SĐT vào tài khoản quản trị
  const seenPhone = new Map(), seenCode = new Set();
  for (const p of people) {
    p.roleId = roles[p.role];
    p.locIds = (p.locs || []).map((c) => locs[c]);
    if (!p.roleId) problems.push(`${p.code} ${p.name}: chức danh ${p.role} không có`);
    if (p.locIds.some((x) => !x)) problems.push(`${p.code} ${p.name}: địa điểm ${p.locs} không có trong hệ thống`);
    if (p.phoneRaw && !p.phone) problems.push(`${p.code} ${p.name}: SĐT không hợp lệ "${p.phoneRaw}"`);
    if (!p.phone && !p.email) problems.push(`${p.code} ${p.name}: không có SĐT lẫn email`);
    if (seenCode.has(p.code)) problems.push(`${p.code}: trùng mã nhân viên`); seenCode.add(p.code);
    if (p.phone && seenPhone.has(p.phone)) problems.push(`${p.code} ${p.name}: trùng SĐT với ${seenPhone.get(p.phone)}`); seenPhone.set(p.phone, p.code);
    p.target = byCode.get(p.code) || null;
    if (p.code === 'S0000') p.target = admin; // Lê Quang Trà = tài khoản quản trị
    for (const u of existing) {
      if (p.target && u.id === p.target.id) continue;
      if (p.email && u.email === p.email) problems.push(`${p.code} ${p.name}: email ${p.email} đã thuộc tài khoản khác`);
      if (p.phone && u.phone === p.phone) problems.push(`${p.code} ${p.name}: SĐT ${p.phone} đã thuộc tài khoản khác`);
    }
  }
  const sum = {};
  for (const p of people) sum[p.role] = (sum[p.role] || 0) + 1;
  console.log(`Tổng ${people.length} nhân viên | tạo mới ${people.filter((p) => !p.target).length} | cập nhật ${people.filter((p) => p.target).length}`);
  console.log('Theo chức danh:', JSON.stringify(sum));
  console.log('Bỏ email dùng chung (đăng nhập bằng SĐT):', people.filter((p) => p.sharedEmail).map((p) => `${p.code}(${p.sharedEmail})`).join(', ') || 'không');
  if (problems.length) { console.log('LỖI:'); for (const x of problems) console.log('  ' + x); process.exitCode = 1; }
  if (!commit || problems.length) { console.log(commit ? 'Có lỗi – không lưu.' : 'Chạy thử xong – chưa lưu gì. Thêm --commit để tạo tài khoản.'); }
  else {
    await db.run("INSERT INTO sessions(token_hash, user_id, expires_at, ip, method) VALUES (?,?,datetime('now','+60 minutes'),'127.0.0.1','script')", sha256(token), admin.id);
    ({ server } = createApp({ serveStatic: false }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port, cookie = 'sbtt_sid=' + token;
    const out = [['MNV', 'Họ và tên', 'Chức danh', 'Phạm vi', 'Đăng nhập bằng', 'Mật khẩu tạm']];
    let created = 0, updated = 0;
    for (const p of people) {
      const body = { employee_code: p.code, full_name: p.name, email: p.email, phone: p.phone, role_id: p.roleId, department: p.dept,
        all_locations: !!p.all, location_ids: p.locIds, status: 'active' };
      if (p.target?.id === admin.id) { // tài khoản quản trị: chỉ bổ sung mã NV, SĐT, họ tên – giữ email & chức danh quản trị
        await db.run("UPDATE users SET employee_code=?, full_name=?, phone=?, department=?, updated_at=datetime('now') WHERE id=?", p.code, p.name, p.phone, p.dept, admin.id);
        updated++; continue;
      }
      const r = p.target ? await post(port, 'PUT', `/api/users/${p.target.id}`, cookie, body) : await post(port, 'POST', '/api/users', cookie, body);
      if (r.status !== 200) { console.log(`  ✖ ${p.code} ${p.name}: ${r.json.error}`); process.exitCode = 1; continue; }
      if (p.target) updated++; else created++;
      if (r.json.temp_password) out.push([p.code, p.name, p.role, p.all ? 'Toàn hệ thống' : p.locs.join(' '), p.email || p.phone, r.json.temp_password]);
    }
    const outFile = path.join(ROOT, 'data', `mat-khau-tam-${new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)}.csv`);
    fs.writeFileSync(outFile, toCsv(out));
    console.log(`Đã tạo ${created}, cập nhật ${updated}. Mật khẩu tạm: ${outFile}`);
  }
} finally {
  await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token)).catch(() => {});
  server?.close();
  await sql.end();
}
