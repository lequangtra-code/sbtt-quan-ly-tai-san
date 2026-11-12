import { tx, Rollback, newQrToken, nextAssetCode, normalizePhone } from '../db.js';
import { can, canLocation, locationFilter } from '../rbac.js';
import { bad, forbidden, notFound, parseCsv, toCsv, esc, sendHtml } from '../http.js';
import { qrSvg } from '../qr.js';

// Nhóm trường theo bộ phận – quyết định ai được xem/sửa
export const GENERAL = ['name', 'category_id', 'area', 'custodian_user_id', 'brand', 'model', 'serial_no', 'specs', 'notes', 'purchase_date', 'supplier', 'invoice_no'];
export const ACCOUNTING = ['accounting_code', 'accounting_type', 'accounting_account', 'cost_center', 'in_service_date', 'original_cost', 'useful_life_months'];
export const MAINT = ['criticality', 'warranty_until', 'warranty_provider', 'warranty_contact', 'maintenance_cycle_days', 'maintenance_vendor', 'next_maintenance_date'];
const DATE_FIELDS = ['performed_date', 'purchase_date', 'in_service_date', 'warranty_until', 'next_maintenance_date', 'last_maintenance_date'];
const NUM_FIELDS = ['category_id', 'custodian_user_id', 'original_cost', 'useful_life_months', 'maintenance_cycle_days', 'location_id'];
const INT_FIELDS = ['category_id', 'custodian_user_id', 'useful_life_months', 'maintenance_cycle_days', 'location_id'];
export const STATUS = { in_use: 'Đang sử dụng', in_storage: 'Lưu kho', under_repair: 'Đang sửa chữa', broken: 'Hỏng chờ xử lý', liquidated: 'Đã thanh lý', lost: 'Mất' };

const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // giờ Việt Nam
export const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + Number(n)); return t.toISOString().slice(0, 10); };

export function clean(field, v) {
  if (v === '' || v === undefined) return null;
  if (v === null) return null;
  if (DATE_FIELDS.includes(field)) {
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    throw bad(`Ngày không hợp lệ (${field}): ${s}`);
  }
  if (NUM_FIELDS.includes(field)) {
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) throw bad(`Giá trị số không hợp lệ (${field})`);
    return INT_FIELDS.includes(field) ? Math.round(n) : n;
  }
  return String(v).trim();
}

export function depreciation(a) {
  const start = a.in_service_date || a.purchase_date;
  if (!a.original_cost || !a.useful_life_months || !start) return null;
  const [y, m] = start.split('-').map(Number);
  const [ty, tm] = today().split('-').map(Number);
  const months = Math.max(0, Math.min(a.useful_life_months, (ty - y) * 12 + (tm - m)));
  const monthly = a.original_cost / a.useful_life_months;
  const accumulated = Math.round(monthly * months);
  return { monthly: Math.round(monthly), months_used: months, accumulated, remaining_value: Math.max(0, Math.round(a.original_cost - accumulated)) };
}

const SELECT = `SELECT a.*, l.code AS location_code, l.name AS location_name, l.type AS location_type,
  c.code AS category_code, c.name AS category_name, c.grp AS category_group,
  u.full_name AS custodian_name, u.phone AS custodian_phone, u.email AS custodian_email
  FROM assets a JOIN locations l ON l.id = a.location_id JOIN asset_categories c ON c.id = a.category_id
  LEFT JOIN users u ON u.id = a.custodian_user_id`;

/** Ẩn các trường theo quyền của người xem */
export function present(a, access) {
  const out = { ...a };
  out.status_label = STATUS[a.status];
  if (!can(access, 'accounting.view')) for (const f of ACCOUNTING) delete out[f];
  else out.depreciation = depreciation(a);
  if (!can(access, 'maintenance.view')) { for (const f of MAINT) if (f !== 'criticality') delete out[f]; delete out.last_maintenance_date; }
  else {
    const t = today();
    out.maintenance_due = a.next_maintenance_date ? (a.next_maintenance_date < t ? 'overdue' : a.next_maintenance_date <= addDays(t, 14) ? 'soon' : 'ok') : null;
    out.warranty_active = a.warranty_until ? a.warranty_until >= t : null;
  }
  return out;
}

export default function registerAssets({ db, api, audit, config }) {
  const getAsset = async (id, access) => {
    const a = await db.get(SELECT + ' WHERE a.id = ?', id);
    if (!a) throw notFound('Không tìm thấy tài sản');
    if (access && !canLocation(access, a.location_id)) throw forbidden('Tài sản thuộc địa điểm ngoài phạm vi của bạn');
    return a;
  };
  const qrUrl = (a) => `${config.publicBaseUrl}/q/${a.qr_token}`;

  function buildFilter(q, access) {
    const lf = locationFilter(access);
    const where = [lf.sql]; const params = [...lf.params];
    if (q.q) { where.push('(a.asset_code ILIKE ? OR a.name ILIKE ? OR a.serial_no ILIKE ? OR a.model ILIKE ? OR a.brand ILIKE ?)'); params.push(...Array(5).fill(`%${q.q}%`)); }
    if (q.location_id) { where.push('a.location_id = ?'); params.push(Number(q.location_id)); }
    if (q.location_type) { where.push('l.type = ?'); params.push(q.location_type); }
    if (q.category_id) { where.push('a.category_id = ?'); params.push(Number(q.category_id)); }
    if (q.group) { where.push('c.grp = ?'); params.push(q.group); }
    if (q.status) { where.push('a.status = ?'); params.push(q.status); }
    else if (!q.include_closed) where.push("a.status NOT IN ('liquidated','lost')");
    if (q.criticality) { where.push('a.criticality = ?'); params.push(q.criticality); }
    if (q.custodian_user_id) { where.push('a.custodian_user_id = ?'); params.push(Number(q.custodian_user_id)); }
    if (q.ids) { const ids = String(q.ids).split(',').map(Number).filter(Boolean); where.push(`a.id IN (${ids.map(() => '?').join(',') || 'NULL'})`); params.push(...ids); }
    if (can(access, 'maintenance.view')) {
      if (q.due === 'overdue') { where.push('a.next_maintenance_date < ?'); params.push(today()); }
      if (q.due === '30d') { where.push('a.next_maintenance_date <= ?'); params.push(addDays(today(), 30)); }
      if (q.warranty === 'expiring') { where.push('a.warranty_until BETWEEN ? AND ?'); params.push(today(), addDays(today(), 60)); }
    }
    return { sql: where.join(' AND '), params };
  }

  api.get('/api/assets', 'asset.view', async ({ query, access }) => {
    const f = buildFilter(query, access);
    const size = Math.min(500, Number(query.size) || 50), page = Math.max(1, Number(query.page) || 1);
    const sort = { code: 'a.asset_code', name: 'a.name', location: 'l.code, a.asset_code', next_mt: 'a.next_maintenance_date IS NULL, a.next_maintenance_date', updated: 'a.updated_at DESC' }[query.sort] || 'l.code, a.asset_code';
    const total = (await db.get(`SELECT COUNT(*) n FROM assets a JOIN locations l ON l.id=a.location_id JOIN asset_categories c ON c.id=a.category_id WHERE ${f.sql}`, ...f.params)).n;
    const rows = await db.all(`${SELECT} WHERE ${f.sql} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...f.params, size, (page - 1) * size);
    return { total, page, size, items: rows.map((r) => present(r, access)) };
  });

  api.get('/api/assets/:id', 'asset.view', async ({ params, access }) => {
    const a = await getAsset(Number(params.id), access);
    return assetDetail(a, access);
  });

  async function assetDetail(a, access) {
    const out = { asset: present(a, access), qr_url: qrUrl(a) };
    if (can(access, 'maintenance.view')) out.maintenance = await db.all(`SELECT m.*, u.full_name AS created_by_name FROM maintenance_records m LEFT JOIN users u ON u.id=m.created_by WHERE asset_id = ? ORDER BY performed_date DESC, m.id DESC`, a.id);
    if (can(access, 'incident.view') || can(access, 'incident.manage')) out.incidents = await db.all(`SELECT i.*, r.full_name AS reported_by_name, s.full_name AS assigned_to_name FROM incidents i LEFT JOIN users r ON r.id=i.reported_by LEFT JOIN users s ON s.id=i.assigned_to WHERE asset_id = ? ORDER BY i.id DESC`, a.id);
    out.transfers = await db.all(`SELECT t.*, fl.name AS from_location_name, tl.name AS to_location_name, ru.full_name AS requested_by_name, du.full_name AS decided_by_name
      FROM transfers t JOIN locations fl ON fl.id=t.from_location_id JOIN locations tl ON tl.id=t.to_location_id
      LEFT JOIN users ru ON ru.id=t.requested_by LEFT JOIN users du ON du.id=t.decided_by WHERE asset_id = ? ORDER BY t.id DESC`, a.id);
    if (can(access, 'audit.view')) out.audit = await db.all(`SELECT g.*, u.full_name AS user_name FROM audit_logs g LEFT JOIN users u ON u.id=g.user_id WHERE entity='asset' AND entity_id = ? ORDER BY g.id DESC LIMIT 100`, a.id);
    return out;
  }

  async function checkCustodian(id) {
    if (id && !(await db.get("SELECT 1 AS x FROM users WHERE id = ? AND status='active'", id))) throw bad('Người quản lý tài sản không hợp lệ');
  }

  async function createAsset(ctx, input, { skipAudit } = {}) {
    const { access } = ctx;
    const locId = Number(input.location_id);
    const loc = Number.isInteger(locId) && locId > 0 ? await db.get('SELECT * FROM locations WHERE id = ?', locId) : null;
    if (!loc) throw bad('Chưa chọn địa điểm');
    if (!canLocation(access, loc.id)) throw forbidden('Địa điểm ngoài phạm vi của bạn');
    const catId = Number(input.category_id);
    const cat = Number.isInteger(catId) && catId > 0 ? await db.get('SELECT * FROM asset_categories WHERE id = ?', catId) : null;
    if (!cat) throw bad('Chưa chọn loại tài sản');
    if (!input.name) throw bad('Chưa nhập tên tài sản');
    const rec = { location_id: loc.id, status: STATUS[input.status] ? input.status : 'in_use' };
    for (const f of [...GENERAL, ...MAINT]) if (input[f] !== undefined) rec[f] = clean(f, input[f]);
    for (const f of ACCOUNTING) if (input[f] !== undefined && input[f] !== '' && input[f] !== null) {
      if (!can(access, 'accounting.update')) throw forbidden('Bạn không có quyền nhập thông tin kế toán');
      rec[f] = clean(f, input[f]);
    }
    if (rec.criticality && !['A', 'B', 'C'].includes(rec.criticality)) throw bad('Mức độ quan trọng phải là A, B hoặc C');
    rec.criticality ||= 'B';
    rec.maintenance_cycle_days ??= cat.maintenance_cycle_days;
    rec.useful_life_months ??= cat.useful_life_months;
    if (!rec.next_maintenance_date && rec.maintenance_cycle_days) rec.next_maintenance_date = addDays(today(), rec.maintenance_cycle_days);
    await checkCustodian(rec.custodian_user_id);
    rec.asset_code = input.asset_code ? String(input.asset_code).trim().toUpperCase() : await nextAssetCode(db, cat.code, loc.code);
    rec.qr_token = await newQrToken();
    rec.created_by = access.user.id;
    const cols = Object.keys(rec);
    const { lastInsertRowid } = await db.run(`INSERT INTO assets(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => rec[c]));
    if (!skipAudit) await audit(ctx, 'asset.create', 'asset', Number(lastInsertRowid), { asset_code: rec.asset_code });
    return Number(lastInsertRowid);
  }

  api.post('/api/assets', 'asset.create', async (ctx) => {
    const id = await tx(db, () => createAsset(ctx, ctx.body));
    return assetDetail(await getAsset(id), ctx.access);
  });

  api.put('/api/assets/:id', ['asset.update', 'accounting.update', 'maintenance.plan', 'asset.status'], async (ctx) => {
    const { access, body } = ctx;
    const a = await getAsset(Number(ctx.params.id), access);
    const changes = {};
    const consider = (fields, perm, label) => {
      for (const f of fields) {
        if (!(f in body)) continue;
        const v = clean(f, body[f]);
        if ((v ?? null) === (a[f] ?? null)) continue;
        if (!can(access, perm)) throw forbidden(`Bạn không có quyền sửa nhóm thông tin ${label}`);
        changes[f] = v;
      }
    };
    consider(GENERAL, 'asset.update', 'chung');
    consider(ACCOUNTING, 'accounting.update', 'kế toán');
    consider(MAINT, 'maintenance.plan', 'bảo trì/bảo hành');
    if ('status' in body && body.status !== a.status) {
      if (!can(access, 'asset.status')) throw forbidden('Bạn không có quyền đổi trạng thái tài sản');
      if (!STATUS[body.status]) throw bad('Trạng thái không hợp lệ');
      changes.status = body.status;
    }
    if ('location_id' in body && Number(body.location_id) !== a.location_id) {
      if (!can(access, 'transfer.approve')) throw forbidden('Đổi địa điểm phải tạo đề nghị điều chuyển');
      if (!canLocation(access, body.location_id)) throw forbidden('Địa điểm mới ngoài phạm vi');
      changes.location_id = Number(body.location_id);
    }
    if ('asset_code' in body && body.asset_code && body.asset_code !== a.asset_code) {
      if (!can(access, 'asset.update')) throw forbidden();
      changes.asset_code = String(body.asset_code).trim().toUpperCase();
    }
    if (changes.criticality && !['A', 'B', 'C'].includes(changes.criticality)) throw bad('Mức độ quan trọng phải là A, B hoặc C');
    if (changes.category_id && !(await db.get('SELECT 1 AS x FROM asset_categories WHERE id=?', changes.category_id))) throw bad('Loại tài sản không hợp lệ');
    if ('custodian_user_id' in changes) await checkCustodian(changes.custodian_user_id);
    if (!Object.keys(changes).length) return assetDetail(a, access);
    const cols = Object.keys(changes);
    await db.run(`UPDATE assets SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...cols.map((c) => changes[c]), a.id);
    await audit(ctx, 'asset.update', 'asset', a.id, Object.fromEntries(cols.map((c) => [c, { from: a[c] ?? null, to: changes[c] }])));
    return assetDetail(await getAsset(a.id), access);
  });

  api.del('/api/assets/:id', 'asset.delete', async (ctx) => {
    const a = await getAsset(Number(ctx.params.id), ctx.access);
    await db.run('DELETE FROM assets WHERE id = ?', a.id);
    await audit(ctx, 'asset.delete', 'asset', a.id, { asset_code: a.asset_code, name: a.name });
    return { ok: true };
  });

  api.post('/api/assets/:id/regenerate-qr', 'asset.update', async (ctx) => {
    const a = await getAsset(Number(ctx.params.id), ctx.access);
    const t = await newQrToken();
    await db.run("UPDATE assets SET qr_token = ?, updated_at = datetime('now') WHERE id = ?", t, a.id);
    await audit(ctx, 'asset.qr_regenerate', 'asset', a.id, { note: 'Mã QR cũ bị vô hiệu' });
    return assetDetail(await getAsset(a.id), ctx.access);
  });

  // Giữ để tương thích; giao diện mới tự vẽ QR trên trình duyệt từ qr_url
  api.get('/api/assets/:id/qr.svg', 'asset.view', async (ctx) => {
    const a = await getAsset(Number(ctx.params.id), ctx.access);
    ctx.res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300' });
    ctx.res.end(qrSvg(qrUrl(a), { ecl: 'Q', scale: 6 }));
  });

  // ---- Quét QR ----
  api.get('/api/scan/:token', null, async (ctx) => {
    const a = await db.get(SELECT + ' WHERE a.qr_token = ?', ctx.params.token);
    if (!a) throw notFound('Mã QR không hợp lệ hoặc đã bị thu hồi');
    const { access } = ctx;
    const minimal = { asset_code: a.asset_code, name: a.name, category_name: a.category_name, location_name: a.location_name,
      location_code: a.location_code, area: a.area, status: a.status, status_label: STATUS[a.status], hotline: config.maintenanceHotline };
    if (!access) {
      if (!config.publicScan) return { login_required: true };
      return { mode: 'public', asset: minimal };
    }
    if (access.user.must_change_password) return { mode: 'public', asset: minimal, must_change_password: true };
    const inScope = canLocation(access, a.location_id);
    if (!inScope || !can(access, 'asset.view')) return { mode: 'limited', asset: minimal };
    if (ctx.query.log !== '0') await audit(ctx, 'asset.scan', 'asset', a.id);
    return { mode: 'full', id: a.id, can_report: can(access, 'incident.create'), ...(await assetDetail(a, access)) };
  });

  // ---- In nhãn QR (mã QR được vẽ bằng JavaScript trên trình duyệt: /qr.js) ----
  api.get('/print/labels', 'asset.qr_print', async (ctx) => {
    const f = buildFilter({ ...ctx.query, include_closed: 1 }, ctx.access);
    const rows = await db.all(`${SELECT} WHERE ${f.sql} ORDER BY l.code, a.asset_code LIMIT 1000`, ...f.params);
    const size = { s: [50, 30], m: [70, 50], l: [100, 70] }[ctx.query.size] || [70, 50];
    const hotline = config.maintenanceHotline;
    const labels = rows.map((a) => `
      <div class="label">
        <div class="qr" data-url="${esc(qrUrl(a))}"></div>
        <div class="info">
          <div class="co">${esc(config.companyShort)} · QUẢN LÝ TÀI SẢN</div>
          <div class="code">${esc(a.asset_code)}</div>
          <div class="name">${esc(a.name)}</div>
          <div class="meta">${esc(a.location_code)} · ${esc(a.location_name)}</div>
          ${a.serial_no ? `<div class="meta">S/N: ${esc(a.serial_no)}</div>` : ''}
          <div class="hint">Quét QR để xem thông tin / báo hỏng${hotline ? ` · Bảo trì: ${esc(hotline)}` : ''}</div>
        </div>
      </div>`).join('');
    await audit(ctx, 'asset.qr_print', 'asset', null, { count: rows.length, ids: rows.slice(0, 50).map((r) => r.id) });
    sendHtml(ctx.res, 200, `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>In nhãn QR (${rows.length})</title>
<style>
  @page { margin: 6mm; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; color: #000; }
  .bar { padding: 12px; background: #0b4a6f; color: #fff; display: flex; gap: 12px; align-items: center; }
  .bar button { font-size: 15px; padding: 8px 16px; cursor: pointer; }
  .sheet { display: flex; flex-wrap: wrap; gap: 3mm; padding: 4mm; }
  .label { width: ${size[0]}mm; height: ${size[1]}mm; border: 0.3mm dashed #888; box-sizing: border-box; padding: 1.5mm; display: flex; gap: 1.5mm; align-items: center; page-break-inside: avoid; overflow: hidden; }
  .qr { width: ${Math.min(size[1] - 3, size[0] * 0.46)}mm; height: ${Math.min(size[1] - 3, size[0] * 0.46)}mm; flex: none; }
  .qr svg { width: 100%; height: 100%; }
  .info { min-width: 0; display: flex; flex-direction: column; justify-content: center; }
  .co { font-size: ${size[0] < 60 ? 5 : 6.5}pt; font-weight: bold; letter-spacing: .3px; }
  .code { font-size: ${size[0] < 60 ? 7 : size[0] > 90 ? 13 : 9.5}pt; font-weight: bold; margin: .5mm 0; white-space: nowrap; letter-spacing: -.2px; }
  .name { font-size: ${size[0] < 60 ? 6 : 8}pt; font-weight: bold; }
  .meta { font-size: ${size[0] < 60 ? 5 : 7}pt; }
  .hint { font-size: ${size[0] < 60 ? 4.5 : 6}pt; margin-top: 1mm; font-style: italic; }
  @media print { .bar { display: none; } .sheet { padding: 0; } }
</style></head><body>
<div class="bar"><b>${rows.length} nhãn</b> · Khổ ${size[0]}×${size[1]} mm
  <button onclick="window.print()">🖨️ In nhãn</button>
  <span>Khổ nhãn: <a style="color:#fff" href="?${esc(new URLSearchParams({ ...ctx.query, size: 's' }))}">50×30</a> ·
  <a style="color:#fff" href="?${esc(new URLSearchParams({ ...ctx.query, size: 'm' }))}">70×50</a> ·
  <a style="color:#fff" href="?${esc(new URLSearchParams({ ...ctx.query, size: 'l' }))}">100×70</a></span></div>
<div class="sheet">${labels || '<p>Không có tài sản phù hợp.</p>'}</div>
<script type="module">
  import { qrSvg } from '/qr.js';
  for (const el of document.querySelectorAll('.qr[data-url]')) el.innerHTML = qrSvg(el.dataset.url, { ecl: 'Q', scale: 3 });
</script></body></html>`);
  });

  // ---- Nhập / xuất CSV ----
  const IMPORT_COLS = ['asset_code', 'name', 'category_code', 'location_code', 'area', 'brand', 'model', 'serial_no', 'specs', 'status', 'criticality',
    'custodian', 'purchase_date', 'supplier', 'invoice_no', 'warranty_until', 'warranty_provider', 'warranty_contact', 'maintenance_cycle_days',
    'maintenance_vendor', 'next_maintenance_date', 'accounting_code', 'accounting_type', 'accounting_account', 'cost_center', 'in_service_date',
    'original_cost', 'useful_life_months', 'notes'];

  api.get('/api/assets/import-template.csv', 'asset.import', (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mau-nhap-tai-san.csv"' });
    ctx.res.end(toCsv([IMPORT_COLS, ['', 'Tủ đông Sanaky 500L', 'DL', 'S08', 'Khu thực phẩm đông lạnh', 'Sanaky', 'VH-5699HY', 'SN123456', '500 lít, 2 cánh',
      'in_use', 'A', '0901234567', '15/03/2024', 'Điện máy XYZ', 'HD00123', '15/03/2026', 'Sanaky VN', '1800xxxx', '90', 'Đội bảo trì', '', 'TS-2024-015', 'CCDC', '242', 'S08', '20/03/2024', '12500000', '36', '']]));
  });

  api.post('/api/assets/import', 'asset.import', async (ctx) => {
    const rows = parseCsv(String(ctx.body.csv || ''));
    if (rows.length < 2) throw bad('File không có dữ liệu');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const cats = Object.fromEntries((await db.all('SELECT id, code FROM asset_categories')).map((c) => [c.code.toUpperCase(), c.id]));
    const locs = Object.fromEntries((await db.all('SELECT id, code FROM locations')).map((l) => [l.code.toUpperCase(), l.id]));
    const results = { created: 0, updated: 0, errors: [] };
    const dryRun = !!ctx.body.dry_run;
    return tx(db, async () => {
      for (const [i, r] of rows.slice(1).entries()) {
        const line = i + 2;
        const rec = Object.fromEntries(header.map((h, k) => [h, (r[k] ?? '').trim()]));
        try {
          // Mỗi dòng 1 SAVEPOINT: lỗi ở 1 dòng không làm hỏng cả giao dịch PostgreSQL
          await tx(db, async () => {
            rec.category_id = cats[String(rec.category_code).toUpperCase()];
            if (!rec.category_id) throw bad(`Mã loại "${rec.category_code}" không tồn tại`);
            rec.location_id = locs[String(rec.location_code).toUpperCase()];
            if (!rec.location_id) throw bad(`Mã địa điểm "${rec.location_code}" không tồn tại`);
            if (rec.custodian) {
              const c = rec.custodian;
              const u = await db.get('SELECT id FROM users WHERE email = ? OR phone = ? OR lower(employee_code) = lower(?)', c.toLowerCase(), normalizePhone(c), c);
              if (!u) throw bad(`Không tìm thấy người quản lý "${c}"`);
              rec.custodian_user_id = u.id;
            }
            if (!can(ctx.access, 'accounting.update')) for (const f of ACCOUNTING) delete rec[f];
            const existing = rec.asset_code && await db.get('SELECT id FROM assets WHERE asset_code = ?', rec.asset_code.toUpperCase());
            if (existing) {
              const a = await getAsset(existing.id, ctx.access);
              const set = {};
              for (const f of [...GENERAL, ...MAINT, ...(can(ctx.access, 'accounting.update') ? ACCOUNTING : [])]) if (rec[f] !== undefined && rec[f] !== '') set[f] = clean(f, rec[f]);
              if (STATUS[rec.status]) set.status = rec.status;
              if (rec.location_id !== a.location_id) throw bad('Không đổi địa điểm qua file nhập – dùng chức năng điều chuyển');
              const cols = Object.keys(set);
              if (cols.length) await db.run(`UPDATE assets SET ${cols.map((c) => c + '=?').join(',')}, updated_at=datetime('now') WHERE id=?`, ...cols.map((c) => set[c]), a.id);
              results.updated++;
            } else {
              await createAsset(ctx, rec, { skipAudit: true });
              results.created++;
            }
          });
        } catch (e) {
          results.errors.push({ line, error: e.code ? 'Dữ liệu không hợp lệ hoặc bị trùng: ' + (e.detail || e.message) : e.message });
        }
      }
      if (dryRun || results.errors.length) throw new Rollback({ ...results, committed: false });
      await audit(ctx, 'asset.import', 'asset', null, { created: results.created, updated: results.updated });
      return { ...results, committed: true };
    });
  });

  api.get('/api/assets/export.csv', 'asset.export', async (ctx) => {
    const f = buildFilter(ctx.query, ctx.access);
    const rows = (await db.all(`${SELECT} WHERE ${f.sql} ORDER BY l.code, a.asset_code`, ...f.params)).map((r) => present(r, ctx.access));
    const cols = [['asset_code', 'Mã tài sản'], ['name', 'Tên tài sản'], ['category_name', 'Loại'], ['location_code', 'Mã địa điểm'], ['location_name', 'Địa điểm'],
      ['area', 'Vị trí đặt'], ['brand', 'Hãng'], ['model', 'Model'], ['serial_no', 'Số serial'], ['status_label', 'Trạng thái'], ['criticality', 'Mức quan trọng'],
      ['custodian_name', 'Người quản lý'], ['custodian_phone', 'SĐT người quản lý'], ['purchase_date', 'Ngày mua'], ['supplier', 'Nhà cung cấp'], ['invoice_no', 'Số hoá đơn']];
    if (can(ctx.access, 'maintenance.view')) cols.push(['warranty_until', 'Bảo hành đến'], ['warranty_provider', 'Đơn vị bảo hành'], ['maintenance_cycle_days', 'Chu kỳ bảo trì (ngày)'],
      ['last_maintenance_date', 'Bảo trì gần nhất'], ['next_maintenance_date', 'Bảo trì kế tiếp'], ['maintenance_vendor', 'Đơn vị bảo trì']);
    if (can(ctx.access, 'accounting.view')) cols.push(['accounting_code', 'Mã TS kế toán'], ['accounting_type', 'Phân loại KT'], ['accounting_account', 'Tài khoản'],
      ['cost_center', 'Trung tâm chi phí'], ['in_service_date', 'Ngày đưa vào sử dụng'], ['original_cost', 'Nguyên giá'], ['useful_life_months', 'Số tháng phân bổ'],
      ['_acc', 'Đã khấu hao/phân bổ'], ['_rem', 'Giá trị còn lại']);
    cols.push(['_url', 'Link QR']);
    const data = rows.map((r) => cols.map(([k]) => k === '_acc' ? r.depreciation?.accumulated ?? '' : k === '_rem' ? r.depreciation?.remaining_value ?? '' : k === '_url' ? qrUrl(r) : r[k]));
    await audit(ctx, 'asset.export', 'asset', null, { count: rows.length });
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tai-san-${today()}.csv"` });
    ctx.res.end(toCsv([cols.map((c) => c[1]), ...data]));
  });

  return { getAsset };
}
