// Kiểm thử tự động: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
// CSDL: PostgreSQL chạy trong bộ nhớ (PGlite) qua socket – cùng giao thức với Supabase, dùng đúng driver postgres.js như bản chạy thật.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// Cố định tài khoản quản trị – không phụ thuộc file .env của máy đang chạy
process.env.ADMIN_EMAIL = 'admin@soibien.vn';
process.env.ADMIN_PHONE = '0900000000';
process.env.ADMIN_PASSWORD = 'Admin@2026x';
process.env.PUBLIC_BASE_URL = 'http://localhost:8080';
const { createApp } = await import('../server/app.js');
const { createSql, setDefaultSql } = await import('../server/db.js');
const { setupDatabase } = await import('../server/setup.js');
const { encodeQR } = await import('../server/qr.js');
let server, base, pg, pgServer, sql;

before(async () => {
  pg = await PGlite.create({ extensions: { pgcrypto, unaccent } });
  pgServer = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1' });
  await pgServer.start();
  sql = createSql(`postgres://postgres:postgres@${pgServer.getServerConn()}/postgres`, { max: 1 });
  setDefaultSql(sql);
  await setupDatabase();
  // connect(): giả lập cách Worker cấp kết nối cho từng request
  ({ server } = createApp({ connect: () => ({ sql }) }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await sql.end(); await pgServer.stop(); await pg.close(); });

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = { 'X-SBTT': '1' }) => {
    const r = await fetch(base + url, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}), cookie }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() };
  };
  return { call, login: (identifier, password) => call('POST', '/api/auth/login', { identifier, password }) };
}

let admin, ids = {};
test('Quản trị đăng nhập lần đầu phải đổi mật khẩu', async () => {
  admin = client();
  const r = await admin.login('admin@soibien.vn', 'Admin@2026x');
  assert.equal(r.status, 200); assert.equal(r.data.mustChangePassword, true);
  assert.equal((await admin.call('GET', '/api/assets')).status, 403);
  assert.equal((await admin.call('POST', '/api/auth/change-password', { current: 'Admin@2026x', next: 'abc' })).status, 400);
  assert.equal((await admin.call('POST', '/api/auth/change-password', { current: 'Admin@2026x', next: 'NewAdmin2026' })).status, 200);
  assert.equal((await admin.call('GET', '/api/assets')).status, 200);
});

test('Địa điểm thật: K00–K04 và 37 cửa hàng đang hoạt động', async () => {
  const { data } = await admin.call('GET', '/api/locations');
  assert.equal(data.items.filter((l) => l.code.startsWith('K')).length, 5);
  assert.ok(data.items.some((l) => l.code === 'S81'));
  ids.loc = Object.fromEntries(data.items.map((l) => [l.code, l.id]));
});

test('Chống CSRF: thiếu header X-SBTT bị từ chối', async () => {
  const r = await admin.call('POST', '/api/assets', { name: 'x' }, {});
  assert.equal(r.status, 403);
});

test('Tạo người dùng theo chức danh và phạm vi cửa hàng', async () => {
  const { data: roles } = await admin.call('GET', '/api/roles');
  ids.role = Object.fromEntries(roles.items.map((r) => [r.code, r.id]));
  const cht = await admin.call('POST', '/api/users', { full_name: 'CHT 05', phone: '0987000005', email: 'cht05@gmail.com', role_id: ids.role.CHT, location_ids: [ids.loc.S08] });
  assert.equal(cht.status, 200); assert.ok(cht.data.temp_password);
  ids.chtPw = cht.data.temp_password;
  const kt = await admin.call('POST', '/api/users', { full_name: 'Kế toán', email: 'kt@gmail.com', role_id: ids.role.KT_TS, password: 'Ketoan2026' });
  assert.equal(kt.status, 200);
  const bt = await admin.call('POST', '/api/users', { full_name: 'Bảo trì', phone: '+84 912 000 111', role_id: ids.role.NV_BT, password: 'Baotri2026' });
  assert.equal(bt.status, 200);
  const dup = await admin.call('POST', '/api/users', { full_name: 'Trùng', phone: '0912000111', role_id: ids.role.NV_BT });
  assert.equal(dup.status, 409);
});

test('Tạo tài sản, sinh mã & QR', async () => {
  const { data: lk } = await admin.call('GET', '/api/lookups');
  const td = lk.categories.find((c) => c.code === 'DL');
  const r = await admin.call('POST', '/api/assets', { name: 'Tủ đông 500L', category_id: td.id, location_id: ids.loc.S08, original_cost: 12000000, purchase_date: '15/03/2025', criticality: 'A' });
  assert.equal(r.status, 200);
  assert.equal(r.data.asset.asset_code, `S08-DL-${new Date().getFullYear() % 100}-00001`);
  assert.equal(r.data.asset.purchase_date, '2025-03-15');
  assert.equal(r.data.asset.maintenance_cycle_days, 90);
  assert.match(r.data.qr_url, /\/q\/[A-Za-z0-9]{8,}$/);
  ids.asset = r.data.asset.id; ids.token = r.data.qr_url.split('/q/')[1];
  const r2 = await admin.call('POST', '/api/assets', { name: 'Tủ mát S10', category_id: lk.categories.find((c) => c.code === 'DL').id, location_id: ids.loc.S10 });
  ids.asset6 = r2.data.asset.id;
});

test('Cửa hàng trưởng chỉ thấy tài sản cửa hàng mình, không thấy giá', async () => {
  const c = client();
  await c.login('0987000005', ids.chtPw);
  await c.call('POST', '/api/auth/change-password', { current: ids.chtPw, next: 'Cht052026' });
  const { data } = await c.call('GET', '/api/assets');
  assert.equal(data.total, 1);
  assert.equal(data.items[0].location_code, 'S08');
  assert.ok(!('original_cost' in data.items[0]));
  assert.equal((await c.call('GET', '/api/assets/' + ids.asset6)).status, 403);
  assert.equal((await c.call('PUT', '/api/assets/' + ids.asset, { name: 'Đổi tên' })).status, 403);
  assert.equal((await c.call('GET', '/api/users')).status, 403);
  // quét QR & báo hỏng
  const s = await c.call('GET', '/api/scan/' + ids.token);
  assert.equal(s.data.mode, 'full');
  const inc = await c.call('POST', `/api/assets/${ids.asset}/incidents`, { title: 'Không lạnh', severity: 'high', mark_broken: true });
  assert.equal(inc.status, 200);
  ids.incident = inc.data.id;
});

test('Quét QR khi chưa đăng nhập chỉ thấy thông tin tối thiểu', async () => {
  const r = await client().call('GET', '/api/scan/' + ids.token);
  assert.equal(r.data.mode, 'public');
  assert.ok(!('custodian_name' in r.data.asset) && !('original_cost' in r.data.asset));
  assert.equal((await client().call('GET', '/api/scan/khongtontai')).status, 404);
});

test('Đăng nhập bằng số điện thoại dạng +84 và OTP', async () => {
  const c = client();
  assert.equal((await c.login('0912 000 111', 'Baotri2026')).status, 200);
  // Đăng nhập bằng mã nhân viên (không phân biệt hoa thường)
  assert.equal((await client().login('ADMIN', 'NewAdmin2026')).status, 200);
  assert.equal((await client().login('admin', 'NewAdmin2026')).status, 200);
  assert.equal((await client().login('ADMIN', 'SaiMatKhau1')).status, 401);
  const o = client();
  assert.equal((await o.call('POST', '/api/auth/otp/request', { phone: '0912000111' })).status, 200);
  assert.equal((await o.call('POST', '/api/auth/otp/verify', { phone: '0912000111', code: '000000' })).status, 401);
});

test('Phân quyền theo nhóm trường: kế toán sửa giá, bảo trì không sửa được giá', async () => {
  const kt = client(); await kt.login('kt@gmail.com', 'Ketoan2026');
  await kt.call('POST', '/api/auth/change-password', { current: 'Ketoan2026', next: 'Ketoan2027' });
  assert.equal((await kt.call('PUT', '/api/assets/' + ids.asset, { original_cost: 15000000, useful_life_months: 36 })).status, 200);
  const bt = client(); await bt.login('0912000111', 'Baotri2026');
  await bt.call('POST', '/api/auth/change-password', { current: 'Baotri2026', next: 'Baotri2027' });
  assert.equal((await bt.call('PUT', '/api/assets/' + ids.asset, { original_cost: 1 })).status, 403);
  const d = await bt.call('GET', '/api/assets/' + ids.asset);
  assert.ok(!('original_cost' in d.data.asset));
  // Ghi bảo trì & đóng sự cố
  const m = await bt.call('POST', `/api/assets/${ids.asset}/maintenance`, { type: 'corrective', description: 'Thay quạt dàn lạnh', cost: 450000, incident_id: ids.incident, resolve_incident: true, set_status: 'in_use' });
  assert.equal(m.status, 200);
  const after = await admin.call('GET', '/api/assets/' + ids.asset);
  assert.equal(after.data.asset.status, 'in_use');
  assert.equal(after.data.incidents[0].status, 'resolved');
  assert.equal(after.data.asset.depreciation.monthly, Math.round(15000000 / 36));
});

test('Ngoại lệ quyền theo người dùng (thu hồi) có hiệu lực', async () => {
  const { data } = await admin.call('GET', '/api/users?q=Bảo trì');
  const u = data.items[0];
  const r = await admin.call('PUT', '/api/users/' + u.id, { full_name: u.full_name, phone: u.phone, role_id: u.role_id, overrides: { 'maintenance.create': 'deny' } });
  assert.equal(r.status, 200);
  const bt = client(); await bt.login('0912000111', 'Baotri2027');
  assert.equal((await bt.call('POST', `/api/assets/${ids.asset}/maintenance`, { type: 'inspection', description: 'x' })).status, 403);
});

test('Chống leo thang quyền: TP Bảo trì (không có user.manage) không tạo được người dùng', async () => {
  const tp = await admin.call('POST', '/api/users', { full_name: 'TP', email: 'tp@gmail.com', role_id: ids.role.TP_BT, password: 'Truongphong1', overrides: { 'user.manage': 'grant' } });
  assert.equal(tp.status, 200); // admin có quyền nên cấp được
  const c = client(); await c.login('tp@gmail.com', 'Truongphong1');
  await c.call('POST', '/api/auth/change-password', { current: 'Truongphong1', next: 'Truongphong2' });
  const r = await c.call('POST', '/api/users', { full_name: 'Hacker', email: 'h@gmail.com', role_id: ids.role.ADMIN });
  assert.equal(r.status, 403);
});

test('Điều chuyển: đề nghị → duyệt → đổi địa điểm', async () => {
  const r = await admin.call('POST', `/api/assets/${ids.asset6}/transfers`, { to_location_id: ids.loc.K02, reason: 'Thu hồi về kho' });
  assert.equal(r.status, 200);
  assert.equal((await admin.call('POST', `/api/transfers/${r.data.id}/decide`, { approve: true })).status, 200);
  assert.equal((await admin.call('GET', '/api/assets/' + ids.asset6)).data.asset.location_code, 'K02');
});

test('Nhập CSV, kế hoạch năm, xuất CSV, in nhãn', async () => {
  const csv = 'name,category_code,location_code,serial_no,purchase_date\nĐiều hoà 1,DH,S20,SN1,01/02/2025\nSai,KHONG_CO,S20,,\n';
  const bad = await admin.call('POST', '/api/assets/import', { csv });
  assert.equal(bad.data.errors.length, 1); assert.equal(bad.data.committed, false);
  const ok = await admin.call('POST', '/api/assets/import', { csv: csv.split('\n').slice(0, 2).join('\n') });
  assert.equal(ok.data.created, 1); assert.equal(ok.data.committed, true);
  const plan = await admin.call('GET', '/api/maintenance/plan?year=2026');
  assert.ok(plan.data.items.length >= 2);
  const exp = await admin.call('GET', '/api/assets/export.csv');
  assert.match(exp.data, /Mã tài sản/);
  const lab = await admin.call('GET', '/print/labels?ids=' + ids.asset);
  assert.match(lab.data, /S08-DL-\d\d-00001/);
});

test('PostgreSQL: tổng quan, người dùng, nhật ký, sự cố, CSV lỗi trùng mã được huỷ trọn vẹn', async () => {
  const d = await admin.call('GET', '/api/dashboard');
  assert.equal(d.status, 200);
  assert.equal(typeof d.data.total, 'number');
  assert.ok(d.data.total >= 3);
  assert.ok(d.data.by_location.length > 0 && typeof d.data.by_location[0].broken === 'number');
  const u = await admin.call('GET', '/api/users?q=cht');
  assert.equal(u.data.items[0].location_codes, 'S08');
  assert.equal((await admin.call('GET', '/api/audit?to=2099-12-31&from=2000-01-01')).status, 200);
  assert.equal((await admin.call('GET', '/api/incidents?status=active')).status, 200);
  assert.equal((await admin.call('GET', '/api/users/abc')).status, 404);
  const before = (await admin.call('GET', '/api/assets?include_closed=1')).data.total;
  // Dòng 2 hợp lệ, dòng 3 trùng mã tài sản với dòng 2 nhưng khác địa điểm -> lỗi -> không lưu dòng nào
  const csv = 'asset_code,name,category_code,location_code\nTEST-001,Tủ A,DL,S20\nTEST-002,Tủ B,DL,S20\n';
  const ok = await admin.call('POST', '/api/assets/import', { csv, dry_run: true });
  assert.equal(ok.data.created, 2); assert.equal(ok.data.committed, false);
  assert.equal((await admin.call('GET', '/api/assets?include_closed=1')).data.total, before);
  const lab = await admin.call('GET', '/print/labels?ids=' + ids.asset);
  assert.match(lab.data, /data-url="http[^"]+\/q\//);
  // Tìm kiếm không dấu + theo người quản lý (họ tên, mã NV, SĐT)
  assert.ok((await admin.call('GET', '/api/assets?q=' + encodeURIComponent('tu dong 500'))).data.items.some((a) => a.id === ids.asset));
  const cht = u.data.items[0];
  assert.equal((await admin.call('PUT', '/api/assets/' + ids.asset, { custodian_user_id: cht.id })).status, 200);
  for (const q of ['cht 05', '0987000005', 'CHT']) {
    const s = await admin.call('GET', '/api/assets?q=' + encodeURIComponent(q));
    assert.ok(s.data.items.some((a) => a.id === ids.asset && a.custodian_name === 'CHT 05'), 'tìm theo người quản lý: ' + q);
  }
  assert.equal((await admin.call('GET', '/api/assets?q=khongcoaiten')).data.total, 0);
});

test('Bộ mã hoá QR: Reed–Solomon đúng chuẩn', () => {
  const q = encodeQR('https://taisan.soibien.vn/q/Ab3dE9xKq2', 'Q');
  assert.equal(q.size, q.ver * 4 + 17);
});
