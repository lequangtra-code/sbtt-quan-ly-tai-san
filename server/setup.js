// Khởi tạo / nâng cấp CSDL: tạo bảng, đồng bộ danh mục quyền, nạp dữ liệu gốc khi CSDL còn trống.
// Chỉ chạy từ Node.js (npm run db:setup, kiểm thử) – không chạy trong Worker.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, tx, normalizePhone } from './db.js';
import { PERMISSIONS, DEFAULT_ROLES } from './rbac.js';
import { LOCATIONS, CATEGORIES } from './seed-data.js';

export async function setupDatabase() {
  await db.exec(fs.readFileSync(path.join(ROOT, 'server', 'schema.pg.sql'), 'utf8'));
  await tx(db, async () => {
    for (const [i, [c, m, n]] of PERMISSIONS.entries()) {
      await db.run('INSERT INTO permissions(code, module, name, sort) VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET module=excluded.module, name=excluded.name, sort=excluded.sort', c, m, n, i);
    }
    if (await db.get('SELECT 1 AS x FROM roles LIMIT 1')) return;
    for (const l of LOCATIONS) await db.run('INSERT INTO locations(code, name, type, active) VALUES (?,?,?,?)', ...l);
    for (const c of CATEGORIES) await db.run('INSERT INTO asset_categories(code, name, grp, maintenance_cycle_days, useful_life_months, label_qr) VALUES (?,?,?,?,?,?)', ...c);
    for (const r of DEFAULT_ROLES) {
      const { lastInsertRowid: id } = await db.run('INSERT INTO roles(code, name, department, all_locations, is_system) VALUES (?,?,?,?,?)', r.code, r.name, r.department, r.all, r.system || 0);
      for (const p of new Set(r.perms)) await db.run('INSERT INTO role_permissions(role_id, permission_code) VALUES (?,?)', id, p);
    }
    const adminRole = (await db.get("SELECT id FROM roles WHERE code='ADMIN'")).id;
    await db.run(`INSERT INTO users(employee_code, full_name, email, phone, password_hash, role_id, department, all_locations, must_change_password)
                  VALUES ('ADMIN', 'Quản trị hệ thống', ?, ?, sbtt_hash_password(?), ?, 'IT', 1, 1)`,
      config.adminEmail.toLowerCase(), normalizePhone(config.adminPhone), config.adminPassword, adminRole);
    await db.run("INSERT INTO settings(key, value) VALUES ('asset_code_seq', '0')");
    console.log(`Đã khởi tạo CSDL. Tài khoản quản trị: ${config.adminEmail} (bắt buộc đổi mật khẩu lần đầu)`);
  });
}
