import { tx } from '../db.js';
import { can, canLocation, locationFilter } from '../rbac.js';
import { bad, forbidden, notFound, HttpError } from '../http.js';
import { addDays, clean, depreciation } from './assets.js';

const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const MT_TYPES = { preventive: 'Bảo trì định kỳ', corrective: 'Sửa chữa', inspection: 'Kiểm tra', warranty: 'Bảo hành' };
const intOrNull = (v) => { const n = Number(v); return v && Number.isInteger(n) ? n : null; };

export default function registerOps({ db, api, audit }) {
  const asset = async (id, access) => {
    const n = Number(id);
    const a = Number.isInteger(n) ? await db.get('SELECT * FROM assets WHERE id = ?', n) : null;
    if (!a) throw notFound('Không tìm thấy tài sản');
    if (!canLocation(access, a.location_id)) throw forbidden('Tài sản thuộc địa điểm ngoài phạm vi của bạn');
    return a;
  };

  // ================= BẢO TRÌ =================
  api.post('/api/assets/:id/maintenance', 'maintenance.create', async (ctx) => {
    const a = await asset(ctx.params.id, ctx.access);
    const b = ctx.body;
    if (!MT_TYPES[b.type]) throw bad('Loại công việc không hợp lệ');
    if (!b.description) throw bad('Chưa nhập nội dung công việc');
    const date = clean('performed_date', b.performed_date) || today();
    if (date > today()) throw bad('Ngày thực hiện không được ở tương lai');
    const incidentId = intOrNull(b.incident_id);
    if (incidentId && !(await db.get('SELECT 1 AS x FROM incidents WHERE id = ? AND asset_id = ?', incidentId, a.id))) throw bad('Sự cố không thuộc tài sản này');
    return tx(db, async () => {
      const { lastInsertRowid } = await db.run(`INSERT INTO maintenance_records(asset_id, type, performed_date, performed_by, vendor, description, result, cost, ticket_ref, incident_id, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, a.id, b.type, date, b.performed_by || ctx.access.user.full_name, b.vendor || null, b.description,
        b.result || null, Number(b.cost) || 0, b.ticket_ref || null, incidentId, ctx.access.user.id);
      const upd = {};
      if (!a.last_maintenance_date || date >= a.last_maintenance_date) upd.last_maintenance_date = date;
      if (b.next_maintenance_date && can(ctx.access, 'maintenance.plan')) upd.next_maintenance_date = clean('next_maintenance_date', b.next_maintenance_date);
      else if ((b.type === 'preventive' || b.type === 'inspection') && a.maintenance_cycle_days) upd.next_maintenance_date = addDays(date, a.maintenance_cycle_days);
      if (b.set_status && ['in_use', 'under_repair', 'broken'].includes(b.set_status) && b.set_status !== a.status) upd.status = b.set_status;
      const cols = Object.keys(upd);
      if (cols.length) await db.run(`UPDATE assets SET ${cols.map((c) => c + '=?').join(',')}, updated_at=datetime('now') WHERE id=?`, ...cols.map((c) => upd[c]), a.id);
      if (incidentId && b.resolve_incident && can(ctx.access, 'incident.manage')) {
        await db.run("UPDATE incidents SET status='resolved', resolution=?, resolved_at=datetime('now') WHERE id=? AND asset_id=?", b.description, incidentId, a.id);
      }
      await audit(ctx, 'maintenance.create', 'asset', a.id, { record_id: Number(lastInsertRowid), type: b.type, date, ...upd });
      return { ok: true, id: Number(lastInsertRowid) };
    });
  });

  api.get('/api/maintenance/schedule', 'maintenance.view', async ({ query, access }) => {
    const lf = locationFilter(access);
    const days = Math.min(366, Number(query.days) || 30);
    const where = [lf.sql, "a.status NOT IN ('liquidated','lost')", 'a.next_maintenance_date IS NOT NULL', 'a.next_maintenance_date <= ?'];
    const params = [...lf.params, addDays(today(), days)];
    if (query.location_id) { where.push('a.location_id = ?'); params.push(Number(query.location_id)); }
    if (query.group) { where.push('c.grp = ?'); params.push(query.group); }
    const rows = await db.all(`SELECT a.id, a.asset_code, a.name, a.criticality, a.status, a.next_maintenance_date, a.last_maintenance_date, a.maintenance_cycle_days, a.maintenance_vendor,
        l.code AS location_code, l.name AS location_name, c.name AS category_name, c.grp AS category_group
      FROM assets a JOIN locations l ON l.id=a.location_id JOIN asset_categories c ON c.id=a.category_id
      WHERE ${where.join(' AND ')} ORDER BY a.next_maintenance_date, a.criticality, l.code`, ...params);
    const t = today();
    return { today: t, items: rows.map((r) => ({ ...r, overdue_days: r.next_maintenance_date < t ? Math.round((Date.parse(t) - Date.parse(r.next_maintenance_date)) / 864e5) : 0 })) };
  });

  // Kế hoạch bảo trì năm: dự kiến theo chu kỳ + thực tế đã làm
  api.get('/api/maintenance/plan', 'maintenance.view', async ({ query, access }) => {
    const year = Number(query.year) || Number(today().slice(0, 4));
    const start = `${year}-01-01`, end = `${year}-12-31`;
    const lf = locationFilter(access);
    const where = [lf.sql, "a.status NOT IN ('liquidated','lost')", 'a.maintenance_cycle_days > 0'];
    const params = [...lf.params];
    if (query.location_id) { where.push('a.location_id = ?'); params.push(Number(query.location_id)); }
    if (query.group) { where.push('c.grp = ?'); params.push(query.group); }
    const assets = await db.all(`SELECT a.id, a.asset_code, a.name, a.criticality, a.next_maintenance_date, a.maintenance_cycle_days, l.code AS location_code, l.name AS location_name,
      c.name AS category_name, c.grp AS category_group FROM assets a JOIN locations l ON l.id=a.location_id JOIN asset_categories c ON c.id=a.category_id
      WHERE ${where.join(' AND ')} ORDER BY l.code, c.grp, a.asset_code`, ...params);
    const done = await db.all(`SELECT asset_id, performed_date FROM maintenance_records WHERE type IN ('preventive','inspection') AND performed_date BETWEEN ? AND ?`, start, end);
    const doneMap = new Map();
    for (const d of done) { const k = d.asset_id; if (!doneMap.has(k)) doneMap.set(k, []); doneMap.get(k).push(d.performed_date); }
    const items = assets.map((a) => {
      const planned = [];
      const cyc = a.maintenance_cycle_days;
      let d = a.next_maintenance_date || today();
      while (d > start) d = addDays(d, -cyc);
      for (let guard = 0; d <= end && guard < 400; guard++, d = addDays(d, cyc)) if (d >= start) planned.push(d);
      const months = Array.from({ length: 12 }, (_, m) => {
        const mm = String(m + 1).padStart(2, '0');
        return { planned: planned.filter((x) => x.slice(5, 7) === mm), done: (doneMap.get(a.id) || []).filter((x) => x.slice(5, 7) === mm) };
      });
      return { ...a, months };
    });
    const totals = Array.from({ length: 12 }, (_, m) => ({ planned: items.reduce((s, i) => s + i.months[m].planned.length, 0), done: items.reduce((s, i) => s + i.months[m].done.length, 0) }));
    return { year, items, totals };
  });

  api.get('/api/maintenance/records', 'maintenance.view', async ({ query, access }) => {
    const lf = locationFilter(access);
    const where = [lf.sql]; const params = [...lf.params];
    if (query.from) { where.push('m.performed_date >= ?'); params.push(query.from); }
    if (query.to) { where.push('m.performed_date <= ?'); params.push(query.to); }
    if (query.type) { where.push('m.type = ?'); params.push(query.type); }
    if (query.location_id) { where.push('a.location_id = ?'); params.push(Number(query.location_id)); }
    const rows = await db.all(`SELECT m.*, a.asset_code, a.name AS asset_name, l.code AS location_code, l.name AS location_name
      FROM maintenance_records m JOIN assets a ON a.id=m.asset_id JOIN locations l ON l.id=a.location_id
      WHERE ${where.join(' AND ')} ORDER BY m.performed_date DESC, m.id DESC LIMIT 500`, ...params);
    return { items: rows, total_cost: rows.reduce((s, r) => s + (r.cost || 0), 0) };
  });

  // ================= SỰ CỐ / BÁO HỎNG =================
  api.post('/api/assets/:id/incidents', 'incident.create', async (ctx) => {
    const a = await asset(ctx.params.id, ctx.access);
    const { title, description, severity = 'normal', mark_broken } = ctx.body;
    if (!title) throw bad('Chưa nhập mô tả ngắn sự cố');
    if (!['low', 'normal', 'high', 'critical'].includes(severity)) throw bad('Mức độ không hợp lệ');
    if (!(await rateLimitIncident(db, ctx.access.user.id))) throw new HttpError(429, 'Bạn đã báo quá nhiều sự cố trong thời gian ngắn');
    const { lastInsertRowid } = await db.run('INSERT INTO incidents(asset_id, title, description, severity, reported_by) VALUES (?,?,?,?,?)',
      a.id, String(title).slice(0, 200), description || null, severity, ctx.access.user.id);
    if (mark_broken && a.status === 'in_use') await db.run("UPDATE assets SET status='broken', updated_at=datetime('now') WHERE id=?", a.id);
    await audit(ctx, 'incident.create', 'asset', a.id, { incident_id: Number(lastInsertRowid), title, severity });
    return { ok: true, id: Number(lastInsertRowid) };
  });

  api.get('/api/incidents', ['incident.view', 'incident.manage'], async ({ query, access }) => {
    const lf = locationFilter(access);
    const where = [lf.sql]; const params = [...lf.params];
    if (query.status === 'active') where.push("i.status IN ('open','in_progress')");
    else if (query.status) { where.push('i.status = ?'); params.push(query.status); }
    if (query.location_id) { where.push('a.location_id = ?'); params.push(Number(query.location_id)); }
    const rows = await db.all(`SELECT i.*, a.asset_code, a.name AS asset_name, a.criticality, l.code AS location_code, l.name AS location_name,
        r.full_name AS reported_by_name, r.phone AS reported_by_phone, s.full_name AS assigned_to_name
      FROM incidents i JOIN assets a ON a.id=i.asset_id JOIN locations l ON l.id=a.location_id
      LEFT JOIN users r ON r.id=i.reported_by LEFT JOIN users s ON s.id=i.assigned_to
      WHERE ${where.join(' AND ')} ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, i.id DESC LIMIT 500`, ...params);
    return { items: rows };
  });

  api.put('/api/incidents/:id', 'incident.manage', async (ctx) => {
    const inc = await db.get('SELECT i.*, a.location_id FROM incidents i JOIN assets a ON a.id=i.asset_id WHERE i.id = ?', Number(ctx.params.id));
    if (!inc) throw notFound();
    if (!canLocation(ctx.access, inc.location_id)) throw forbidden();
    const b = ctx.body;
    const status = b.status ?? inc.status;
    if (!['open', 'in_progress', 'resolved', 'cancelled'].includes(status)) throw bad('Trạng thái không hợp lệ');
    const assigned = b.assigned_to === undefined ? inc.assigned_to : (b.assigned_to ? Number(b.assigned_to) : null);
    await db.run(`UPDATE incidents SET status=?, assigned_to=?, resolution=?, resolved_at=CASE WHEN ?::text IN ('resolved','cancelled') THEN COALESCE(resolved_at, datetime('now')) ELSE NULL END WHERE id=?`,
      status, assigned, b.resolution ?? inc.resolution, status, inc.id);
    await audit(ctx, 'incident.update', 'asset', inc.asset_id, { incident_id: inc.id, status, assigned_to: assigned });
    return { ok: true };
  });

  // ================= ĐIỀU CHUYỂN =================
  api.post('/api/assets/:id/transfers', 'transfer.request', async (ctx) => {
    const a = await asset(ctx.params.id, ctx.access);
    const toId = intOrNull(ctx.body.to_location_id);
    const to = toId && await db.get('SELECT * FROM locations WHERE id = ? AND active = 1', toId);
    if (!to) throw bad('Chưa chọn địa điểm nhận');
    if (to.id === a.location_id && !ctx.body.to_custodian_id) throw bad('Địa điểm nhận trùng địa điểm hiện tại');
    if (await db.get("SELECT 1 AS x FROM transfers WHERE asset_id = ? AND status = 'pending'", a.id)) throw bad('Tài sản đang có đề nghị điều chuyển chờ duyệt');
    const toCust = intOrNull(ctx.body.to_custodian_id);
    return tx(db, async () => {
      const { lastInsertRowid } = await db.run(`INSERT INTO transfers(asset_id, from_location_id, to_location_id, from_custodian_id, to_custodian_id, reason, requested_by)
        VALUES (?,?,?,?,?,?,?)`, a.id, a.location_id, to.id, a.custodian_user_id, toCust, ctx.body.reason || null, ctx.access.user.id);
      const id = Number(lastInsertRowid);
      await audit(ctx, 'transfer.request', 'asset', a.id, { transfer_id: id, to: to.code });
      if (ctx.body.auto_approve && can(ctx.access, 'transfer.approve')) await decide(ctx, id, true, 'Duyệt ngay khi tạo');
      return { ok: true, id };
    });
  });

  async function decide(ctx, id, approve, note) {
    const t = Number.isInteger(id) ? await db.get('SELECT * FROM transfers WHERE id = ?', id) : null;
    if (!t) throw notFound();
    if (t.status !== 'pending') throw bad('Đề nghị đã được xử lý');
    if (!canLocation(ctx.access, t.from_location_id) && !canLocation(ctx.access, t.to_location_id)) throw forbidden();
    await db.run("UPDATE transfers SET status=?, decided_by=?, decision_note=?, decided_at=datetime('now') WHERE id=?", approve ? 'approved' : 'rejected', ctx.access.user.id, note || null, id);
    if (approve) await db.run("UPDATE assets SET location_id=?, custodian_user_id=COALESCE(?::integer, CASE WHEN ?::integer <> location_id THEN NULL ELSE custodian_user_id END), updated_at=datetime('now') WHERE id=?",
      t.to_location_id, t.to_custodian_id, t.to_location_id, t.asset_id);
    await audit(ctx, approve ? 'transfer.approve' : 'transfer.reject', 'asset', t.asset_id, { transfer_id: id, note });
  }

  api.post('/api/transfers/:id/decide', 'transfer.approve', async (ctx) => {
    await tx(db, () => decide(ctx, Number(ctx.params.id), !!ctx.body.approve, ctx.body.note));
    return { ok: true };
  });

  api.post('/api/transfers/:id/cancel', 'transfer.request', async (ctx) => {
    const id = Number(ctx.params.id);
    const t = Number.isInteger(id) ? await db.get('SELECT * FROM transfers WHERE id = ?', id) : null;
    if (!t || t.status !== 'pending') throw bad('Không thể huỷ');
    if (t.requested_by !== ctx.access.user.id && !can(ctx.access, 'transfer.approve')) throw forbidden();
    await db.run("UPDATE transfers SET status='cancelled', decided_by=?, decided_at=datetime('now') WHERE id=?", ctx.access.user.id, t.id);
    await audit(ctx, 'transfer.cancel', 'asset', t.asset_id, { transfer_id: t.id });
    return { ok: true };
  });

  api.get('/api/transfers', ['transfer.request', 'transfer.approve'], async ({ query, access }) => {
    const lf1 = locationFilter(access, 't.from_location_id'), lf2 = locationFilter(access, 't.to_location_id');
    const where = [`(${lf1.sql} OR ${lf2.sql})`]; const params = [...lf1.params, ...lf2.params];
    if (query.status) { where.push('t.status = ?'); params.push(query.status); }
    const rows = await db.all(`SELECT t.*, a.asset_code, a.name AS asset_name, fl.code AS from_code, fl.name AS from_location_name, tl.code AS to_code, tl.name AS to_location_name,
        ru.full_name AS requested_by_name, du.full_name AS decided_by_name, tc.full_name AS to_custodian_name
      FROM transfers t JOIN assets a ON a.id=t.asset_id JOIN locations fl ON fl.id=t.from_location_id JOIN locations tl ON tl.id=t.to_location_id
      LEFT JOIN users ru ON ru.id=t.requested_by LEFT JOIN users du ON du.id=t.decided_by LEFT JOIN users tc ON tc.id=t.to_custodian_id
      WHERE ${where.join(' AND ')} ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.id DESC LIMIT 300`, ...params);
    return { items: rows };
  });

  // ================= TỔNG QUAN =================
  api.get('/api/dashboard', 'dashboard.view', async ({ access }) => {
    const lf = locationFilter(access);
    const base = `FROM assets a JOIN locations l ON l.id=a.location_id JOIN asset_categories c ON c.id=a.category_id WHERE ${lf.sql}`;
    const active = `${base} AND a.status NOT IN ('liquidated','lost')`;
    const t = today();
    const mv = can(access, 'maintenance.view');
    // Chạy song song các truy vấn độc lập để giảm thời gian chờ
    const [total, by_status, by_group, by_location_type, by_criticality, broken_critical] = await Promise.all([
      db.get(`SELECT COUNT(*) n ${active}`, ...lf.params).then((r) => r.n),
      db.all(`SELECT a.status, COUNT(*) n ${base} GROUP BY a.status`, ...lf.params),
      db.all(`SELECT c.grp AS grp, COUNT(*) n ${active} GROUP BY c.grp ORDER BY n DESC`, ...lf.params),
      db.all(`SELECT l.type, COUNT(*) n ${active} GROUP BY l.type`, ...lf.params),
      db.all(`SELECT a.criticality, COUNT(*) n ${active} GROUP BY a.criticality`, ...lf.params),
      db.all(`SELECT a.id, a.asset_code, a.name, a.status, l.code AS location_code ${base} AND a.status IN ('broken','under_repair') ORDER BY a.criticality, a.updated_at DESC LIMIT 15`, ...lf.params),
    ]);
    const out = { today: t, total, by_status, by_group, by_location_type, by_criticality, broken_critical };
    if (mv) {
      [out.maintenance_overdue, out.maintenance_30d, out.warranty_expiring, out.maintenance_cost_month] = await Promise.all([
        db.get(`SELECT COUNT(*) n ${active} AND a.next_maintenance_date < ?`, ...lf.params, t),
        db.get(`SELECT COUNT(*) n ${active} AND a.next_maintenance_date BETWEEN ? AND ?`, ...lf.params, t, addDays(t, 30)),
        db.get(`SELECT COUNT(*) n ${active} AND a.warranty_until BETWEEN ? AND ?`, ...lf.params, t, addDays(t, 60)),
        db.get(`SELECT COALESCE(SUM(m.cost),0) n FROM maintenance_records m JOIN assets a ON a.id=m.asset_id WHERE ${lf.sql} AND m.performed_date >= ?`, ...lf.params, t.slice(0, 8) + '01'),
      ].map((p) => p.then((r) => r.n)));
    }
    if (can(access, 'incident.view') || can(access, 'incident.manage'))
      out.incidents_open = (await db.get(`SELECT COUNT(*) n FROM incidents i JOIN assets a ON a.id=i.asset_id WHERE ${lf.sql} AND i.status IN ('open','in_progress')`, ...lf.params)).n;
    if (can(access, 'transfer.approve'))
      out.transfers_pending = (await db.get("SELECT COUNT(*) n FROM transfers WHERE status='pending'")).n;
    if (can(access, 'accounting.view')) {
      const rows = await db.all(`SELECT a.original_cost, a.useful_life_months, a.in_service_date, a.purchase_date ${active} AND a.original_cost > 0`, ...lf.params);
      let cost = 0, remain = 0;
      for (const r of rows) { cost += r.original_cost; const d = depreciation(r); remain += d ? d.remaining_value : r.original_cost; }
      out.accounting = { original_cost: Math.round(cost), remaining_value: Math.round(remain) };
    }
    out.by_location = await db.all(`SELECT l.id, l.code, l.name, COUNT(a.id) n,
        SUM(CASE WHEN a.status IN ('broken','under_repair') THEN 1 ELSE 0 END) broken
        ${mv ? ", SUM(CASE WHEN a.next_maintenance_date < ? THEN 1 ELSE 0 END) overdue" : ''}
      FROM assets a JOIN locations l ON l.id=a.location_id WHERE ${lf.sql} AND a.status NOT IN ('liquidated','lost') GROUP BY l.id ORDER BY l.code`,
      ...(mv ? [t] : []), ...lf.params);
    return out;
  });
}

async function rateLimitIncident(db, userId) {
  return (await db.get("SELECT COUNT(*) n FROM incidents WHERE reported_by = ? AND created_at > datetime('now','-10 minutes')", userId)).n < 10;
}
