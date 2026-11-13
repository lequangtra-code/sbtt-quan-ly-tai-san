import { tx, normalizePhone } from '../db.js';
import { can, loadAccess, ALL_PERMISSION_CODES } from '../rbac.js';
import { validatePassword, randomToken } from '../security.js';
import { bad, forbidden, notFound, HttpError } from '../http.js';

const LOC_TYPES = { office: 'Văn phòng', warehouse: 'Kho tổng', warehouse_it: 'Kho IT', warehouse_admin: 'Kho hành chính', store: 'Cửa hàng' };
const tempPassword = () => 'Sb' + randomToken(6).replace(/[^A-Za-z0-9]/g, 'x') + Math.floor(Math.random() * 90 + 10);
const idParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw notFound(); return n; };

export default function registerAdmin({ db, api, audit }) {
  // ---------- Danh mục dùng chung ----------
  api.get('/api/permissions', 'auth', async () => ({ items: await db.all('SELECT * FROM permissions ORDER BY sort') }));

  api.get('/api/lookups', 'auth', async ({ access }) => {
    // Tài khoản chưa kích hoạt (mật khẩu tạm) không được xem danh mục người dùng/địa điểm
    if (access.user.must_change_password) throw new HttpError(403, 'Bạn cần đổi mật khẩu trước khi sử dụng', { mustChangePassword: true });
    const showPhone = can(access, 'user.view');
    const needUsers = ['asset.create', 'asset.update', 'transfer.request', 'incident.manage', 'user.view'].some((p) => can(access, p));
    const [locs, categories, users] = await Promise.all([
      db.all('SELECT id, code, name, type, region, active FROM locations ORDER BY CASE type WHEN \'store\' THEN 1 ELSE 0 END, code'),
      db.all('SELECT * FROM asset_categories ORDER BY grp, name'),
      needUsers ? db.all(`SELECT u.id, u.full_name, ${showPhone ? 'u.phone' : 'NULL AS phone'}, u.employee_code, r.name AS role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE u.status='active' ORDER BY u.full_name`) : [],
    ]);
    const locations = locs.map((l) => ({ ...l, in_scope: access.allLocations || access.locationIds.includes(l.id) }));
    return { locations, categories, users, location_types: LOC_TYPES };
  });

  // ---------- Địa điểm ----------
  const locFields = (b) => {
    if (!b.code || !b.name) throw bad('Cần nhập mã và tên địa điểm');
    if (!LOC_TYPES[b.type]) throw bad('Loại địa điểm không hợp lệ');
    return [String(b.code).trim().toUpperCase(), String(b.name).trim(), b.type, b.address || null, b.region || null, b.phone || null, b.manager_user_id ? Number(b.manager_user_id) : null, b.active === false || b.active === 0 ? 0 : 1];
  };
  api.get('/api/locations', 'location.view', async () => ({
    items: await db.all(`SELECT l.*, u.full_name AS manager_name, (SELECT COUNT(*) FROM assets a WHERE a.location_id=l.id AND a.status NOT IN ('liquidated','lost')) AS asset_count
      FROM locations l LEFT JOIN users u ON u.id = l.manager_user_id ORDER BY CASE l.type WHEN 'store' THEN 1 ELSE 0 END, l.code`),
  }));
  api.post('/api/locations', 'location.manage', async (ctx) => {
    const { lastInsertRowid } = await db.run('INSERT INTO locations(code, name, type, address, region, phone, manager_user_id, active) VALUES (?,?,?,?,?,?,?,?)', ...locFields(ctx.body));
    await audit(ctx, 'location.create', 'location', Number(lastInsertRowid), ctx.body);
    return { ok: true, id: Number(lastInsertRowid) };
  });
  api.put('/api/locations/:id', 'location.manage', async (ctx) => {
    const id = idParam(ctx.params.id);
    const r = await db.run('UPDATE locations SET code=?, name=?, type=?, address=?, region=?, phone=?, manager_user_id=?, active=? WHERE id=?', ...locFields(ctx.body), id);
    if (!r.changes) throw notFound();
    await audit(ctx, 'location.update', 'location', id, ctx.body);
    return { ok: true };
  });

  // ---------- Loại tài sản ----------
  const catFields = (b) => {
    if (!b.code || !b.name || !b.grp) throw bad('Cần nhập mã, tên và nhóm');
    return [String(b.code).trim().toUpperCase(), String(b.name).trim(), String(b.grp).trim(), Math.round(Number(b.maintenance_cycle_days)) || null, Math.round(Number(b.useful_life_months)) || null, b.label_qr ? 1 : 0, b.active === false || b.active === 0 ? 0 : 1];
  };
  api.post('/api/categories', 'category.manage', async (ctx) => {
    const { lastInsertRowid } = await db.run('INSERT INTO asset_categories(code, name, grp, maintenance_cycle_days, useful_life_months, label_qr, active) VALUES (?,?,?,?,?,?,?)', ...catFields(ctx.body));
    await audit(ctx, 'category.create', 'category', Number(lastInsertRowid), ctx.body);
    return { ok: true };
  });
  api.put('/api/categories/:id', 'category.manage', async (ctx) => {
    const id = idParam(ctx.params.id);
    await db.run('UPDATE asset_categories SET code=?, name=?, grp=?, maintenance_cycle_days=?, useful_life_months=?, label_qr=?, active=? WHERE id=?', ...catFields(ctx.body), id);
    await audit(ctx, 'category.update', 'category', id, ctx.body);
    return { ok: true };
  });

  // ---------- Chức danh & phân quyền ----------
  const rolePerms = async (id) => (await db.all('SELECT permission_code FROM role_permissions WHERE role_id = ?', id)).map((r) => r.permission_code);
  api.get('/api/roles', ['role.manage', 'user.view'], async () => {
    const [roles, rp] = await Promise.all([
      db.all('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count FROM roles r ORDER BY r.is_system DESC, r.id'),
      db.all('SELECT role_id, permission_code FROM role_permissions'),
    ]);
    return { items: roles.map((r) => ({ ...r, permissions: rp.filter((x) => x.role_id === r.id).map((x) => x.permission_code) })) };
  });

  // Chống leo thang quyền: chỉ được trao những quyền mà chính mình đang có
  const assertGrantable = (access, perms) => {
    const missing = perms.filter((p) => !access.perms.has(p));
    if (missing.length) throw forbidden('Bạn không thể cấp quyền mà chính bạn không có: ' + missing.join(', '));
  };
  const saveRole = async (ctx, id) => {
    const b = ctx.body;
    if (!b.code || !b.name) throw bad('Cần nhập mã và tên chức danh');
    const perms = [...new Set((b.permissions || []).filter((p) => ALL_PERMISSION_CODES.includes(p)))];
    return tx(db, async () => {
      if (id) {
        const role = await db.get('SELECT * FROM roles WHERE id = ?', id);
        if (!role) throw notFound();
        if (role.is_system) throw forbidden('Không sửa chức danh hệ thống (Quản trị)');
        const before = await rolePerms(id);
        assertGrantable(ctx.access, [...perms.filter((p) => !before.includes(p)), ...before.filter((p) => !perms.includes(p))]);
        await db.run('UPDATE roles SET code=?, name=?, department=?, description=?, all_locations=? WHERE id=?', String(b.code).toUpperCase(), b.name, b.department || null, b.description || null, b.all_locations ? 1 : 0, id);
        await db.run('DELETE FROM role_permissions WHERE role_id = ?', id);
        await audit(ctx, 'role.update', 'role', id, { added: perms.filter((p) => !before.includes(p)), removed: before.filter((p) => !perms.includes(p)) });
      } else {
        assertGrantable(ctx.access, perms);
        id = Number((await db.run('INSERT INTO roles(code, name, department, description, all_locations) VALUES (?,?,?,?,?)', String(b.code).toUpperCase(), b.name, b.department || null, b.description || null, b.all_locations ? 1 : 0)).lastInsertRowid);
        await audit(ctx, 'role.create', 'role', id, { permissions: perms });
      }
      for (const p of perms) await db.run('INSERT INTO role_permissions(role_id, permission_code) VALUES (?,?)', id, p);
      return { ok: true, id };
    });
  };
  api.post('/api/roles', 'role.manage', (ctx) => saveRole(ctx, null));
  api.put('/api/roles/:id', 'role.manage', (ctx) => saveRole(ctx, idParam(ctx.params.id)));
  api.del('/api/roles/:id', 'role.manage', async (ctx) => {
    const role = await db.get('SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id=r.id) n FROM roles r WHERE id = ?', idParam(ctx.params.id));
    if (!role) throw notFound();
    if (role.is_system || role.n) throw bad('Không thể xoá chức danh hệ thống hoặc đang có người dùng');
    await db.run('DELETE FROM roles WHERE id = ?', role.id);
    await audit(ctx, 'role.delete', 'role', role.id, { code: role.code });
    return { ok: true };
  });

  // ---------- Người dùng ----------
  api.get('/api/users', 'user.view', async ({ query }) => {
    const where = ['1=1']; const params = [];
    if (query.q) { where.push('(u.full_name ILIKE ? OR u.email ILIKE ? OR u.phone ILIKE ? OR u.employee_code ILIKE ?)'); params.push(...Array(4).fill(`%${query.q}%`)); }
    if (query.role_id) { where.push('u.role_id = ?'); params.push(Number(query.role_id)); }
    if (query.status) { where.push('u.status = ?'); params.push(query.status); }
    if (query.location_id) { where.push('(u.all_locations = 1 OR r.all_locations = 1 OR EXISTS (SELECT 1 FROM user_locations x WHERE x.user_id=u.id AND x.location_id=?))'); params.push(Number(query.location_id)); }
    const rows = await db.all(`SELECT u.id, u.employee_code, u.full_name, u.email, u.phone, u.department, u.status, u.all_locations, u.last_login_at, u.role_id,
        r.name AS role_name, r.code AS role_code, r.all_locations AS role_all,
        (SELECT string_agg(l.code, ', ' ORDER BY l.code) FROM user_locations x JOIN locations l ON l.id=x.location_id WHERE x.user_id=u.id) AS location_codes,
        (SELECT COUNT(*) FROM user_permission_overrides o WHERE o.user_id=u.id) AS override_count
      FROM users u JOIN roles r ON r.id=u.role_id WHERE ${where.join(' AND ')} ORDER BY u.full_name`, ...params);
    return { items: rows };
  });

  api.get('/api/users/:id', 'user.view', async ({ params }) => {
    const u = await db.get('SELECT id, employee_code, full_name, email, phone, role_id, department, all_locations, status, last_login_at, created_at FROM users WHERE id = ?', idParam(params.id));
    if (!u) throw notFound();
    const [acc, locs, ovs, sessions] = await Promise.all([
      loadAccess(db, u.id),
      db.all('SELECT location_id FROM user_locations WHERE user_id = ?', u.id),
      db.all('SELECT permission_code, effect FROM user_permission_overrides WHERE user_id = ?', u.id),
      db.all("SELECT created_at, expires_at, ip, method FROM sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 10", u.id),
    ]);
    return {
      user: u,
      location_ids: locs.map((r) => r.location_id),
      overrides: Object.fromEntries(ovs.map((o) => [o.permission_code, o.effect])),
      effective_permissions: [...acc.perms],
      sessions,
    };
  });

  const saveUser = async (ctx, id) => {
    const b = ctx.body;
    if (!b.full_name) throw bad('Chưa nhập họ tên');
    const email = b.email ? String(b.email).trim().toLowerCase() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Email không hợp lệ');
    const phone = b.phone ? normalizePhone(b.phone) : null;
    if (b.phone && !phone) throw bad('Số điện thoại không hợp lệ (VD: 0901234567)');
    if (!email && !phone) throw bad('Cần có ít nhất email hoặc số điện thoại để đăng nhập');
    const roleId = Number(b.role_id);
    const role = Number.isInteger(roleId) ? await db.get('SELECT * FROM roles WHERE id = ?', roleId) : null;
    if (!role) throw bad('Chưa chọn chức danh');
    const overrides = Object.entries(b.overrides || {}).filter(([p, e]) => ALL_PERMISSION_CODES.includes(p) && ['grant', 'deny'].includes(e));
    const status = b.status === 'locked' ? 'locked' : 'active';
    if (id === ctx.access.user.id && status === 'locked') throw bad('Không thể tự khoá tài khoản của mình');

    // Chống leo thang quyền
    const prev = id ? await db.get('SELECT * FROM users WHERE id = ?', id) : null;
    if (id && !prev) throw notFound();
    if (!prev || prev.role_id !== role.id) assertGrantable(ctx.access, await rolePerms(role.id));
    assertGrantable(ctx.access, overrides.filter(([, e]) => e === 'grant').map(([p]) => p));
    if (prev && !can(ctx.access, 'role.manage')) {
      const target = await loadAccess(db, id);
      if ([...target.perms].some((p) => !ctx.access.perms.has(p))) throw forbidden('Không thể sửa tài khoản có quyền cao hơn bạn');
    }
    if (b.all_locations && !ctx.access.allLocations) throw forbidden('Bạn không thể cấp phạm vi toàn hệ thống');
    const locIds = [...new Set((b.location_ids || []).map(Number))].filter((l) => Number.isInteger(l) && l > 0);
    if (!ctx.access.allLocations && locIds.some((l) => !ctx.access.locationIds.includes(l))) throw forbidden('Có địa điểm ngoài phạm vi của bạn');

    let pw = null, temp = null;
    if (!id) {
      pw = b.password;
      if (pw) { const e = validatePassword(pw); if (e) throw bad(e); } else pw = temp = tempPassword();
    }
    return tx(db, async () => {
      if (id) {
        await db.run("UPDATE users SET employee_code=?, full_name=?, email=?, phone=?, role_id=?, department=?, all_locations=?, status=?, updated_at=datetime('now') WHERE id=?",
          b.employee_code || null, b.full_name, email, phone, role.id, b.department || null, b.all_locations ? 1 : 0, status, id);
        if (status === 'locked') await db.run('DELETE FROM sessions WHERE user_id = ?', id);
      } else {
        id = Number((await db.run('INSERT INTO users(employee_code, full_name, email, phone, password_hash, role_id, department, all_locations, status) VALUES (?,?,?,?,sbtt_hash_password(?),?,?,?,?)',
          b.employee_code || null, b.full_name, email, phone, String(pw), role.id, b.department || null, b.all_locations ? 1 : 0, status)).lastInsertRowid);
      }
      await db.run('DELETE FROM user_locations WHERE user_id = ?', id);
      for (const l of locIds) await db.run('INSERT INTO user_locations(user_id, location_id) VALUES (?,?)', id, l);
      await db.run('DELETE FROM user_permission_overrides WHERE user_id = ?', id);
      for (const [p, e] of overrides) await db.run('INSERT INTO user_permission_overrides(user_id, permission_code, effect) VALUES (?,?,?)', id, p, e);
      await audit(ctx, prev ? 'user.update' : 'user.create', 'user', id, { full_name: b.full_name, email, phone, role: role.code, status, locations: locIds, overrides: Object.fromEntries(overrides) });
      return { ok: true, id, temp_password: temp };
    });
  };
  api.post('/api/users', 'user.manage', (ctx) => saveUser(ctx, null));
  api.put('/api/users/:id', 'user.manage', (ctx) => saveUser(ctx, idParam(ctx.params.id)));

  api.post('/api/users/:id/reset-password', 'user.manage', async (ctx) => {
    const id = idParam(ctx.params.id);
    const target = await loadAccess(db, id);
    if (!target) throw notFound();
    if ([...target.perms].some((p) => !ctx.access.perms.has(p))) throw forbidden('Không thể đặt lại mật khẩu cho tài khoản có quyền cao hơn bạn');
    const pw = tempPassword();
    await db.run("UPDATE users SET password_hash=sbtt_hash_password(?), must_change_password=1, updated_at=datetime('now') WHERE id=?", pw, id);
    await db.run('DELETE FROM sessions WHERE user_id = ?', id);
    await audit(ctx, 'user.reset_password', 'user', id);
    return { ok: true, temp_password: pw };
  });

  // ---------- Nhật ký ----------
  api.get('/api/audit', 'audit.view', async ({ query }) => {
    const where = ['1=1']; const params = [];
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
    if (query.entity) { where.push('g.entity = ?'); params.push(query.entity); }
    if (query.entity_id) { where.push('g.entity_id = ?'); params.push(Number(query.entity_id)); }
    if (query.user_id) { where.push('g.user_id = ?'); params.push(Number(query.user_id)); }
    if (query.action) { where.push('g.action LIKE ?'); params.push(query.action + '%'); }
    if (query.from) { where.push('g.created_at >= ?'); params.push(query.from); }
    if (query.to && isDate(query.to)) { where.push("g.created_at < to_char(?::date + 1, 'YYYY-MM-DD')"); params.push(query.to); }
    const page = Math.max(1, Number(query.page) || 1);
    const rows = await db.all(`SELECT g.*, u.full_name AS user_name, a.asset_code FROM audit_logs g LEFT JOIN users u ON u.id=g.user_id
      LEFT JOIN assets a ON g.entity='asset' AND a.id=g.entity_id WHERE ${where.join(' AND ')} ORDER BY g.id DESC LIMIT 100 OFFSET ?`, ...params, (page - 1) * 100);
    return { items: rows, page };
  });
}
