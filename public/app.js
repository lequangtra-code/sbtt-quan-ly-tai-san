// =====================================================================
// Giao diện Hệ thống Quản lý tài sản – Sói Biển Trung Thực (SPA thuần JS)
// =====================================================================
import { qrSvg } from './qr.js'; // vẽ mã QR ngay trên trình duyệt
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { me: null, perms: new Set(), lookups: null, cfg: null, allLocations: false };
const can = (...p) => p.some((x) => S.perms.has(x));

const STATUS = { in_use: ['Đang sử dụng', 'ok'], in_storage: ['Lưu kho', 'info'], under_repair: ['Đang sửa chữa', 'warn'], broken: ['Hỏng chờ xử lý', 'bad'], liquidated: ['Đã thanh lý', ''], lost: ['Mất', 'bad'] };
const INC_STATUS = { open: ['Mới', 'bad'], in_progress: ['Đang xử lý', 'warn'], resolved: ['Đã xử lý', 'ok'], cancelled: ['Đã huỷ', ''] };
const SEVERITY = { low: ['Thấp', ''], normal: ['Bình thường', 'info'], high: ['Cao', 'warn'], critical: ['Khẩn cấp', 'bad'] };
const TR_STATUS = { pending: ['Chờ duyệt', 'warn'], approved: ['Đã duyệt', 'ok'], rejected: ['Từ chối', 'bad'], cancelled: ['Đã huỷ', ''] };
const MT_TYPES = { preventive: 'Bảo trì định kỳ', corrective: 'Sửa chữa', inspection: 'Kiểm tra', warranty: 'Bảo hành' };
const LOC_TYPES = { office: 'Văn phòng', warehouse: 'Kho tổng', warehouse_it: 'Kho IT', warehouse_admin: 'Kho hành chính', store: 'Cửa hàng' };
const CRIT = { A: 'A – Quan trọng (ảnh hưởng bán hàng/an toàn)', B: 'B – Trung bình', C: 'C – Thấp' };

const badge = (map, k) => { const [l, c] = map[k] || [k, '']; return `<span class="badge ${c}">${esc(l)}</span>`; };
const crit = (c) => (c ? `<span class="crit ${c}" title="${esc(CRIT[c])}">${c}</span>` : '');
const money = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('vi-VN') + ' đ');
const dmy = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const dt = (d) => (d ? new Date(d.replace(' ', 'T') + 'Z').toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '');
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();

// ---------------- API ----------------
async function api(method, url, body) {
  const opt = { method, headers: { 'X-SBTT': '1' }, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const data = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !location.pathname.startsWith('/login') && !location.pathname.startsWith('/q/')) { S.me = null; go('/login?next=' + encodeURIComponent(location.pathname + location.search)); }
    if (r.status === 403 && data?.mustChangePassword) go('/change-password');
    const e = new Error(data?.error || 'Lỗi ' + r.status); e.status = r.status; throw e;
  }
  return data;
}
const GET = (u) => api('GET', u), POST = (u, b = {}) => api('POST', u, b), PUT = (u, b) => api('PUT', u, b), DEL = (u) => api('DELETE', u);

// ---------------- UI helpers ----------------
function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toast-root').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
function modal({ title, body, wide, actions = [] }) {
  const root = $('#modal-root');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}"><header><h2>${esc(title)}</h2><button class="x" data-x>×</button></header><div class="body">${body}</div>
    <footer>${actions.map((a, i) => `<button class="btn ${a.cls || ''}" data-a="${i}">${esc(a.label)}</button>`).join('')}<button class="btn" data-x>Đóng</button></footer></div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', async (e) => {
    if (e.target === bg || e.target.closest('[data-x]')) return close();
    const b = e.target.closest('[data-a]');
    if (b) {
      b.disabled = true;
      try { await actions[Number(b.dataset.a)].onClick({ el: bg, close }); } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
    }
  });
  root.append(bg);
  return { el: bg, close };
}
function confirmBox(text, label = 'Đồng ý', cls = 'primary') {
  return new Promise((res) => {
    const m = modal({ title: 'Xác nhận', body: `<p>${text}</p>`, actions: [{ label, cls, onClick: ({ close }) => { close(); res(true); } }] });
    m.el.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => res(false)));
  });
}
function field({ name, label, type = 'text', value = '', options, required, cls = '', disabled, placeholder = '', attrs = '' }) {
  const dis = disabled ? 'disabled' : '';
  let input;
  if (type === 'select') {
    input = `<select name="${name}" ${dis} ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  } else if (type === 'textarea') input = `<textarea name="${name}" ${dis} placeholder="${esc(placeholder)}" ${attrs}>${esc(value)}</textarea>`;
  else if (type === 'checkbox') return `<label class="f ${cls}" style="display:flex;gap:8px;align-items:center;margin-top:20px"><input type="checkbox" name="${name}" ${value ? 'checked' : ''} ${dis} ${attrs}> ${esc(label)}</label>`;
  else input = `<input name="${name}" type="${type}" value="${esc(value)}" ${dis} placeholder="${esc(placeholder)}" ${attrs}>`;
  return `<label class="f ${cls}"><span>${esc(label)}${required ? ' <i>*</i>' : ''}</span>${input}</label>`;
}
function readForm(el) {
  const o = {};
  for (const i of $$('[name]', el)) {
    if (i.disabled) continue;
    o[i.name] = i.type === 'checkbox' ? i.checked : i.value;
  }
  return o;
}
const locOptions = (scopeOnly = true, blank = 'Tất cả địa điểm') => [['', blank], ...S.lookups.locations.filter((l) => l.active && (!scopeOnly || l.in_scope)).map((l) => [l.id, `${l.code} – ${l.name}`])];
const catOptions = (blank = 'Tất cả loại') => [['', blank], ...S.lookups.categories.filter((c) => c.active).map((c) => [c.id, `${c.grp} › ${c.name}`])];
const groupOptions = () => [['', 'Tất cả nhóm'], ...[...new Set(S.lookups.categories.map((c) => c.grp))].map((g) => [g, g])];
const userOptions = (blank = '— Chưa giao —') => [['', blank], ...S.lookups.users.map((u) => [u.id, `${u.full_name}${u.phone ? ' · ' + u.phone : ''} (${u.role_name})`])];

// ---------------- Router ----------------
function go(path) { history.pushState(null, '', path); route(); }
window.addEventListener('popstate', () => route());
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (a && !a.target && !a.hasAttribute('download') && !a.getAttribute('href').startsWith('/print') && !a.getAttribute('href').startsWith('/api') && !a.getAttribute('href').startsWith('/auth') && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); go(a.getAttribute('href'));
  }
});

const ROUTES = [
  [/^\/login$/, pageLogin, true],
  [/^\/q\/([\w-]+)$/, pageScan, true],
  [/^\/change-password$/, pageChangePw],
  [/^\/$/, pageDashboard],
  [/^\/assets$/, pageAssets],
  [/^\/assets\/new$/, pageAssetForm],
  [/^\/assets\/(\d+)$/, pageAssetDetail],
  [/^\/assets\/(\d+)\/edit$/, pageAssetForm],
  [/^\/maintenance$/, pageMaintenance],
  [/^\/incidents$/, pageIncidents],
  [/^\/transfers$/, pageTransfers],
  [/^\/locations$/, pageLocations],
  [/^\/categories$/, pageCategories],
  [/^\/users$/, pageUsers],
  [/^\/roles$/, pageRoles],
  [/^\/audit$/, pageAudit],
  [/^\/import$/, pageImport],
];

async function loadSession() {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!r.ok) throw new Error();
    const me = await r.json();
    S.me = me.user; S.perms = new Set(me.permissions); S.allLocations = me.allLocations;
    if (!S.me.must_change_password) S.lookups = await GET('/api/lookups');
  } catch { S.me = null; }
}

async function route() {
  if (!S.cfg) S.cfg = await GET('/api/public/config').catch(() => ({}));
  const path = location.pathname;
  const hit = ROUTES.find(([re]) => re.test(path)) || [/./, pageNotFound];
  const [re, page, isPublic] = hit;
  if (S.me === null && !S._tried) { S._tried = true; await loadSession(); }
  if (!isPublic) {
    if (!S.me) return go('/login?next=' + encodeURIComponent(path + location.search));
    if (S.me.must_change_password && path !== '/change-password') return go('/change-password');
  }
  const params = path.match(re)?.slice(1) || [];
  const app = $('#app');
  $('#modal-root').innerHTML = '';
  if (isPublic || path === '/change-password') { app.innerHTML = ''; return page(app, ...params); }
  app.innerHTML = shell(path);
  const content = $('#content');
  try { await page(content, ...params); } catch (e) { content.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
}

function shell(path) {
  const items = [
    ['Tổng quan', [['/', '📊', 'Bảng tổng quan', 'dashboard.view']]],
    ['Tài sản', [['/assets', '📦', 'Danh mục tài sản', 'asset.view'], ['/assets/new', '➕', 'Thêm tài sản', 'asset.create'], ['/import', '📥', 'Nhập từ file', 'asset.import']]],
    ['Vận hành', [['/maintenance', '🛠️', 'Bảo trì & kế hoạch năm', 'maintenance.view'], ['/incidents', '🚨', 'Sự cố / báo hỏng', ['incident.view', 'incident.manage']], ['/transfers', '🔁', 'Điều chuyển', ['transfer.request', 'transfer.approve']]]],
    ['Quản trị', [['/locations', '🏬', 'Địa điểm', 'location.view'], ['/categories', '🏷️', 'Loại tài sản', 'category.manage'], ['/users', '👤', 'Người dùng', 'user.view'], ['/roles', '🔐', 'Chức danh & phân quyền', 'role.manage'], ['/audit', '📜', 'Nhật ký hệ thống', 'audit.view']]],
  ];
  const nav = items.map(([g, list]) => {
    const vis = list.filter(([, , , p]) => can(...[].concat(p)));
    if (!vis.length) return '';
    return `<div class="grp">${g}</div>` + vis.map(([href, ic, label]) => `<a href="${href}" class="${(href === '/' ? path === '/' : path === href || (href === '/assets' && /^\/assets\/\d/.test(path))) ? 'active' : ''}"><span class="ic">${ic}</span>${label}</a>`).join('');
  }).join('');
  return `<div class="shell"><aside class="side" id="side">
      <div class="brand"><img src="/brand/logo-full-white.png" alt="${esc(S.cfg.companyShort || 'SÓI BIỂN')}"><small>Hệ thống quản lý tài sản</small></div>
      <nav class="nav">${nav}</nav>
      <div class="me"><b>${esc(S.me.full_name)}</b>${esc(S.me.role_name)}<div style="margin-top:6px"><a href="/change-password">Đổi mật khẩu</a><a href="#" id="logout">Đăng xuất</a></div></div>
    </aside><main class="main"><div class="top"><button class="btn menu-btn" id="menu">☰</button><h1 id="title"></h1><div class="sp"></div><div id="top-actions" class="row"></div></div>
    <div class="content" id="content"><div class="muted">Đang tải…</div></div></main></div>`;
}
document.addEventListener('click', async (e) => {
  if (e.target.id === 'logout') { e.preventDefault(); await POST('/api/auth/logout'); S.me = null; S._tried = false; go('/login'); }
  if (e.target.id === 'menu') $('#side').classList.toggle('open');
  else if (!e.target.closest('#side')) $('#side')?.classList.remove('open');
});
const setTitle = (t, actions = '') => { document.title = t + ' · Tài sản Sói Biển'; if ($('#title')) $('#title').textContent = t; if ($('#top-actions')) $('#top-actions').innerHTML = actions; };
function pageNotFound(el) { el.innerHTML = '<div class="empty">Không tìm thấy trang.</div>'; }

// ---------------- Đăng nhập ----------------
async function pageLogin(el) {
  const p = new URLSearchParams(location.search);
  const rawNext = p.get('next') || '/';
  const next = /^\/(?![/\\])/.test(rawNext) ? rawNext : '/'; // chỉ chuyển trong website
  if (S.me && !S.me.must_change_password) return go(next);
  el.innerHTML = `<div class="login-wrap"><div class="login login-v2">
    <div class="login-tile"><img class="mark" src="/brand/logo-mark-white.png" alt=""><img class="text" src="/brand/logo-text-white.png" alt="Sói Biển"></div>
    <h1 class="login-h">Sói Biển Tài Sản</h1>
    <p class="login-sub">Đăng nhập bằng mã nhân viên của bạn</p>
    ${p.get('error') ? `<div class="alert bad">${esc(p.get('error'))}</div>` : ''}
    <form id="f-pw" class="stack">
      ${field({ name: 'identifier', label: 'Mã nhân viên', placeholder: 'Ví dụ: S0061', attrs: 'autocomplete="username" autocapitalize="characters" autocorrect="off" spellcheck="false" required autofocus' })}
      <label class="f"><span>Mật khẩu</span><div class="pw-wrap"><input type="password" name="password" autocomplete="current-password" required><button type="button" class="pw-eye" aria-label="Hiện mật khẩu" title="Hiện mật khẩu">${EYE}</button></div></label>
      <button class="btn primary">Đăng nhập</button>
    </form>
    <a href="#" class="login-forgot" id="forgot">Quên mật khẩu?</a>
    ${S.cfg.googleEnabled ? `<div class="or">hoặc</div><a class="btn gbtn" href="/auth/google?next=${encodeURIComponent(next)}">Đăng nhập bằng Google (Gmail)</a>` : ''}
  </div></div>`;
  const done = async (r) => { S._tried = false; S.me = null; await loadSession(); go(r.mustChangePassword ? '/change-password' : next); };
  const pw = $('input[name=password]', el);
  $('.pw-eye', el).onclick = (e) => { const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; e.currentTarget.innerHTML = show ? EYE_OFF : EYE; e.currentTarget.title = show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'; };
  $('#forgot', el).onclick = (e) => { e.preventDefault(); toast('Liên hệ phòng Bảo trì - IT hoặc quản trị viên để được đặt lại mật khẩu.'); };
  $('#f-pw').onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm(e.target);
    f.identifier = String(f.identifier || '').trim();
    if (/^sd+$/i.test(f.identifier)) f.identifier = f.identifier.toUpperCase();
    try { await done(await POST('/api/auth/login', f)); } catch (err) { toast(err.message, true); }
  };
}

const EYE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

async function pageChangePw(el) {
  if (!S.me) return go('/login');
  const forced = S.me.must_change_password;
  el.innerHTML = `<div class="login-wrap"><div class="login"><div class="logo"><img src="/brand/icon-192.png" alt=""><div><b>Đổi mật khẩu</b><small>${esc(S.me.full_name)}</small></div></div>
    ${forced ? '<div class="alert warn">Đây là lần đăng nhập đầu tiên hoặc mật khẩu vừa được đặt lại. Vui lòng đặt mật khẩu mới.</div>' : ''}
    <form class="stack">${field({ name: 'current', label: forced ? 'Mật khẩu hiện tại (mật khẩu tạm)' : 'Mật khẩu hiện tại', type: 'password', attrs: 'autocomplete="current-password"' })}
    ${S.me.verify_phone ? field({ name: 'phone_confirm', label: 'Số điện thoại đã đăng ký với công ty (để xác minh chính chủ)', placeholder: '09xxxxxxxx', attrs: 'inputmode="tel" autocomplete="tel" required' }) : ''}
    ${field({ name: 'next', label: 'Mật khẩu mới (≥ 8 ký tự, có chữ và số)', type: 'password', attrs: 'autocomplete="new-password" required' })}
    ${field({ name: 'next2', label: 'Nhập lại mật khẩu mới', type: 'password', attrs: 'autocomplete="new-password" required' })}
    <button class="btn primary">Lưu mật khẩu</button>${forced ? '' : '<a class="btn" href="/" style="margin-top:8px">Quay lại</a>'}</form></div></div>`;
  $('form', el).onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm(e.target);
    if (f.next !== f.next2) return toast('Mật khẩu nhập lại không khớp', true);
    try { await POST('/api/auth/change-password', f); toast('Đã đổi mật khẩu'); S._tried = false; S.me = null; await loadSession(); go('/'); } catch (err) { toast(err.message, true); }
  };
}

// ---------------- Tổng quan ----------------
async function pageDashboard(el) {
  setTitle('Bảng tổng quan', can('asset.view') ? '<a class="btn" href="/assets">📦 Danh mục tài sản</a>' : '');
  if (!can('dashboard.view')) { el.innerHTML = `<div class="card">Xin chào <b>${esc(S.me.full_name)}</b>. Hãy quét mã QR trên tài sản để xem thông tin hoặc báo hỏng.</div>`; return; }
  const d = await GET('/api/dashboard');
  const st = Object.fromEntries(d.by_status.map((x) => [x.status, x.n]));
  const kpi = (v, l, cls = '', href = '') => `<${href ? `a href="${href}"` : 'div'} class="card kpi ${cls}" style="display:block;text-decoration:none"><div class="v">${v ?? 0}</div><div class="l">${l}</div></${href ? 'a' : 'div'}>`;
  const maxG = Math.max(1, ...d.by_group.map((g) => g.n));
  el.innerHTML = `
    <div class="grid g4">
      ${kpi(d.total, 'Tài sản đang quản lý', '', '/assets')}
      ${kpi((st.broken || 0) + (st.under_repair || 0), 'Hỏng / đang sửa chữa', 'bad', '/assets?status=broken')}
      ${'maintenance_overdue' in d ? kpi(d.maintenance_overdue, 'Bảo trì quá hạn', 'bad', '/maintenance') : ''}
      ${'maintenance_30d' in d ? kpi(d.maintenance_30d, 'Bảo trì đến hạn 30 ngày', 'warn', '/maintenance') : ''}
      ${'incidents_open' in d ? kpi(d.incidents_open, 'Sự cố đang mở', 'bad', '/incidents') : ''}
      ${'transfers_pending' in d ? kpi(d.transfers_pending, 'Điều chuyển chờ duyệt', 'warn', '/transfers') : ''}
      ${'warranty_expiring' in d ? kpi(d.warranty_expiring, 'Bảo hành hết hạn trong 60 ngày', 'warn', '/assets?warranty=expiring') : ''}
      ${'maintenance_cost_month' in d ? kpi(money(d.maintenance_cost_month), 'Chi phí bảo trì tháng này') : ''}
      ${d.accounting ? kpi(money(d.accounting.original_cost), 'Tổng nguyên giá') + kpi(money(d.accounting.remaining_value), 'Giá trị còn lại ước tính', 'ok') : ''}
    </div>
    <div class="grid g2">
      <div class="card"><h2>Theo nhóm thiết bị</h2>${d.by_group.map((g) => `<div style="margin:8px 0"><div class="row"><span>${esc(g.grp)}</span><span class="sp" style="flex:1"></span><b>${g.n}</b></div>
        <div style="height:8px;background:#eef2f5;border-radius:4px"><div style="height:8px;width:${(g.n / maxG) * 100}%;background:var(--teal);border-radius:4px"></div></div></div>`).join('') || '<div class="empty">Chưa có dữ liệu</div>'}
        <h3>Mức độ quan trọng</h3><div class="row">${d.by_criticality.map((c) => `${crit(c.criticality)} <b>${c.n}</b>&nbsp;&nbsp;`).join('')}</div></div>
      <div class="card"><h2>Tài sản hỏng / đang sửa</h2>${d.broken_critical.length ? `<table><tbody>${d.broken_critical.map((a) => `<tr class="clickable" data-go="/assets/${a.id}"><td class="mono">${esc(a.asset_code)}</td><td>${esc(a.name)}</td><td>${esc(a.location_code)}</td><td>${badge(STATUS, a.status)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Không có tài sản hỏng 🎉</div>'}</div>
    </div>
    <div class="card flush"><div style="padding:14px 16px 0"><h2>Theo địa điểm</h2></div><div class="tbl-wrap"><table><thead><tr><th>Mã</th><th>Địa điểm</th><th class="right">Số tài sản</th><th class="right">Hỏng/sửa</th>${'maintenance_overdue' in d ? '<th class="right">Quá hạn bảo trì</th>' : ''}</tr></thead>
      <tbody>${d.by_location.map((l) => `<tr class="clickable" data-go="/assets?location_id=${l.id}"><td class="mono">${esc(l.code)}</td><td>${esc(l.name)}</td><td class="right">${l.n}</td><td class="right">${l.broken ? `<span class="badge bad">${l.broken}</span>` : 0}</td>${'overdue' in l ? `<td class="right">${l.overdue ? `<span class="badge warn">${l.overdue}</span>` : 0}</td>` : ''}</tr>`).join('')}</tbody></table></div></div>`;
  clickRows(el);
}
function clickRows(el) { $$('[data-go]', el).forEach((r) => r.addEventListener('click', (e) => { if (!e.target.closest('a,button,input')) go(r.dataset.go); })); }

// ---------------- Danh mục tài sản ----------------
async function pageAssets(el) {
  const q = Object.fromEntries(new URLSearchParams(location.search));
  q.page ||= 1;
  setTitle('Danh mục tài sản', `${can('asset.create') ? '<a class="btn primary" href="/assets/new">➕ Thêm tài sản</a>' : ''}
    ${can('asset.export') ? `<a class="btn" href="/api/assets/export.csv?${qs({ ...q, page: '' })}" download>⬇️ Xuất CSV</a>` : ''}`);
  const statusOpts = [['', 'Đang quản lý (trừ thanh lý/mất)'], ...Object.entries(STATUS).map(([k, [l]]) => [k, l])];
  el.innerHTML = `<div class="card"><form class="filters" id="flt">
      ${field({ name: 'q', label: 'Tìm kiếm', value: q.q, placeholder: 'Mã, tên, serial, người quản lý…' })}
      ${field({ name: 'location_id', label: 'Địa điểm', type: 'select', options: locOptions(), value: q.location_id })}
      ${field({ name: 'group', label: 'Nhóm', type: 'select', options: groupOptions(), value: q.group })}
      ${field({ name: 'category_id', label: 'Loại', type: 'select', options: catOptions(), value: q.category_id })}
      ${field({ name: 'status', label: 'Trạng thái', type: 'select', options: statusOpts, value: q.status })}
      ${can('maintenance.view') ? field({ name: 'due', label: 'Bảo trì', type: 'select', options: [['', 'Tất cả'], ['overdue', 'Quá hạn'], ['30d', 'Đến hạn ≤ 30 ngày']], value: q.due }) : field({ name: 'criticality', label: 'Mức quan trọng', type: 'select', options: [['', 'Tất cả'], ['A', 'A'], ['B', 'B'], ['C', 'C']], value: q.criticality })}
    </form></div>
    <div class="card flush"><div class="row" style="padding:10px 12px;border-bottom:1px solid var(--line)" id="bulk"><span class="muted" id="cnt"></span><span style="flex:1"></span>
      ${can('asset.qr_print') ? '<button class="btn sm" id="print-sel" disabled>🏷️ In nhãn QR đã chọn</button><button class="btn sm" id="print-all">🏷️ In nhãn theo bộ lọc</button>' : ''}</div>
    <div class="tbl-wrap" id="list"><div class="empty">Đang tải…</div></div></div>`;
  const form = $('#flt', el);
  const apply = () => { const f = readForm(form); go('/assets?' + qs({ ...f, warranty: q.warranty })); };
  form.addEventListener('change', apply);
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
  let timer; $('[name=q]', form).addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 500); });
  if (q.q) { const i = $('[name=q]', form); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }

  const data = await GET('/api/assets?' + qs({ ...q, size: 50 }));
  $('#cnt', el).textContent = `${data.total} tài sản`;
  const mv = can('maintenance.view');
  $('#list', el).innerHTML = data.items.length ? `<table><thead><tr><th style="width:30px"><input type="checkbox" id="all"></th><th>Mã tài sản</th><th>Tên tài sản</th><th class="hide-m">Loại</th><th>Địa điểm</th><th class="hide-m">Người quản lý</th><th>QT</th><th>Trạng thái</th>${mv ? '<th class="hide-m">Bảo trì kế tiếp</th>' : ''}</tr></thead>
    <tbody>${data.items.map((a) => `<tr class="clickable" data-go="/assets/${a.id}"><td><input type="checkbox" class="sel" value="${a.id}"></td><td class="mono nowrap">${esc(a.asset_code)}</td>
      <td><b>${esc(a.name)}</b><div class="small muted">${esc([a.brand, a.model, a.serial_no && 'S/N ' + a.serial_no].filter(Boolean).join(' · '))}</div></td>
      <td class="hide-m">${esc(a.category_name)}</td><td class="nowrap">${esc(a.location_code)}<div class="small muted">${esc(a.area || '')}</div></td><td class="hide-m">${esc(a.custodian_name || '')}</td>
      <td>${crit(a.criticality)}</td><td>${badge(STATUS, a.status)}</td>
      ${mv ? `<td class="hide-m nowrap">${a.next_maintenance_date ? `<span class="badge ${a.maintenance_due === 'overdue' ? 'bad' : a.maintenance_due === 'soon' ? 'warn' : ''}">${dmy(a.next_maintenance_date)}</span>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table>
    <div class="pager">${pager(data, (p) => '/assets?' + qs({ ...q, page: p }))}</div>` : '<div class="empty">Không có tài sản phù hợp.</div>';
  clickRows(el);
  const sel = () => $$('.sel:checked', el).map((c) => c.value);
  $('#all', el)?.addEventListener('change', (e) => { $$('.sel', el).forEach((c) => (c.checked = e.target.checked)); upd(); });
  const upd = () => { const b = $('#print-sel', el); if (b) { b.disabled = !sel().length; b.textContent = `🏷️ In nhãn QR đã chọn (${sel().length})`; } };
  $$('.sel', el).forEach((c) => c.addEventListener('change', upd));
  $('#print-sel', el)?.addEventListener('click', () => window.open('/print/labels?ids=' + sel().join(','), '_blank'));
  $('#print-all', el)?.addEventListener('click', () => { if (data.total > 1000) return toast('Tối đa 1000 nhãn mỗi lần, hãy lọc theo địa điểm', true); window.open('/print/labels?' + qs({ ...q, page: '' }), '_blank'); });
}
function pager(d, href) {
  const pages = Math.ceil(d.total / d.size);
  if (pages <= 1) return '';
  return `<span class="muted small">Trang ${d.page}/${pages}</span>${d.page > 1 ? `<a class="btn sm" href="${href(d.page - 1)}">‹ Trước</a>` : ''}${d.page < pages ? `<a class="btn sm" href="${href(d.page + 1)}">Sau ›</a>` : ''}`;
}

// ---------------- Chi tiết tài sản ----------------
async function pageAssetDetail(el, id) {
  const d = await GET('/api/assets/' + id);
  renderAssetDetail(el, d);
}
function renderAssetDetail(el, d, { scan } = {}) {
  const a = d.asset;
  const id = a.id;
  const acts = [];
  if (can('asset.update', 'accounting.update', 'maintenance.plan')) acts.push(`<a class="btn primary" href="/assets/${id}/edit">✏️ Sửa</a>`);
  if (can('incident.create')) acts.push('<button class="btn danger" data-act="incident">🚨 Báo hỏng</button>');
  if (can('maintenance.create')) acts.push('<button class="btn teal" data-act="maint">🛠️ Ghi bảo trì</button>');
  if (can('transfer.request')) acts.push('<button class="btn" data-act="transfer">🔁 Điều chuyển</button>');
  if (can('asset.status')) acts.push('<button class="btn" data-act="status">🔄 Đổi trạng thái</button>');
  if (can('asset.qr_print')) acts.push(`<a class="btn" href="/print/labels?ids=${id}" target="_blank">🏷️ In nhãn QR</a>`);
  if (can('asset.update')) acts.push('<button class="btn" data-act="reqr">♻️ Cấp lại QR</button>');
  if (can('asset.delete')) acts.push('<button class="btn danger" data-act="delete">🗑️ Xoá</button>');
  if (!scan) setTitle(a.asset_code);

  const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${k}</dt><dd>${v === null || v === '' ? '<span class="muted">—</span>' : v}</dd>`).join('')}</dl>`;
  const tabs = [['info', 'Thông tin chung']];
  if ('original_cost' in a || 'accounting_code' in a) tabs.push(['acc', 'Kế toán']);
  if (d.maintenance) tabs.push(['mt', `Bảo trì & bảo hành (${d.maintenance.length})`]);
  if (d.incidents) tabs.push(['inc', `Sự cố (${d.incidents.filter((i) => ['open', 'in_progress'].includes(i.status)).length} mở)`]);
  tabs.push(['tr', `Điều chuyển (${d.transfers.length})`]);
  if (d.audit) tabs.push(['log', 'Nhật ký']);

  const dep = a.depreciation;
  const panes = {
    info: kv([['Mã tài sản', `<span class="mono">${esc(a.asset_code)}</span>`], ['Tên tài sản', esc(a.name)], ['Loại', `${esc(a.category_group)} › ${esc(a.category_name)}`],
      ['Địa điểm', `${esc(a.location_code)} – ${esc(a.location_name)}`], ['Vị trí đặt', esc(a.area)], ['Người quản lý tài sản', a.custodian_name ? `${esc(a.custodian_name)}${a.custodian_phone ? ` · <a href="tel:${esc(a.custodian_phone)}">${esc(a.custodian_phone)}</a>` : ''}` : ''],
      ['Hãng / Model', esc([a.brand, a.model].filter(Boolean).join(' / '))], ['Số serial', esc(a.serial_no)], ['Thông số', esc(a.specs)], ['Ngày mua', dmy(a.purchase_date)],
      ['Nhà cung cấp', esc(a.supplier)], ['Số hoá đơn', esc(a.invoice_no)], ['Mức quan trọng', a.criticality ? `${crit(a.criticality)} ${esc(CRIT[a.criticality])}` : ''], ['Ghi chú', esc(a.notes)],
      ['Cập nhật', dt(a.updated_at)]]),
    acc: kv([['Mã TS trên PM kế toán', esc(a.accounting_code)], ['Phân loại', esc({ TSCD: 'Tài sản cố định', CCDC: 'Công cụ dụng cụ', KHAC: 'Khác' }[a.accounting_type] || a.accounting_type)],
      ['Tài khoản', esc(a.accounting_account)], ['Trung tâm chi phí', esc(a.cost_center)], ['Ngày đưa vào sử dụng', dmy(a.in_service_date)], ['Nguyên giá', money(a.original_cost)],
      ['Thời gian khấu hao/phân bổ', a.useful_life_months ? a.useful_life_months + ' tháng' : ''], ['Mức khấu hao/tháng', dep ? money(dep.monthly) : ''], ['Đã khấu hao/phân bổ', dep ? `${money(dep.accumulated)} (${dep.months_used} tháng)` : ''],
      ['Giá trị còn lại ước tính', dep ? `<b>${money(dep.remaining_value)}</b>` : '']]) + '<p class="muted small">* Giá trị tính theo phương pháp đường thẳng, chỉ để tham khảo. Số liệu chính thức theo sổ kế toán.</p>',
    mt: d.maintenance ? kv([['Chu kỳ bảo trì', a.maintenance_cycle_days ? a.maintenance_cycle_days + ' ngày' : 'Không định kỳ'], ['Bảo trì gần nhất', dmy(a.last_maintenance_date)],
      ['Bảo trì kế tiếp', a.next_maintenance_date ? `<span class="badge ${a.maintenance_due === 'overdue' ? 'bad' : a.maintenance_due === 'soon' ? 'warn' : 'ok'}">${dmy(a.next_maintenance_date)}</span>` : ''],
      ['Đơn vị bảo trì', esc(a.maintenance_vendor)], ['Bảo hành đến', a.warranty_until ? `${dmy(a.warranty_until)} ${a.warranty_active ? '<span class="badge ok">Còn bảo hành</span>' : '<span class="badge">Hết bảo hành</span>'}` : ''],
      ['Đơn vị bảo hành', esc(a.warranty_provider)], ['Liên hệ bảo hành', esc(a.warranty_contact)]])
      + `<h3>Lịch sử bảo trì / sửa chữa</h3>` + (d.maintenance.length ? `<div class="tbl-wrap"><table><thead><tr><th>Ngày</th><th>Loại</th><th>Nội dung</th><th>Thực hiện</th><th class="right">Chi phí</th></tr></thead><tbody>
      ${d.maintenance.map((m) => `<tr><td class="nowrap">${dmy(m.performed_date)}</td><td>${esc(MT_TYPES[m.type])}</td><td>${esc(m.description)}${m.result ? `<div class="small muted">Kết quả: ${esc(m.result)}</div>` : ''}</td><td>${esc(m.performed_by || '')}${m.vendor ? `<div class="small muted">${esc(m.vendor)}</div>` : ''}</td><td class="right nowrap">${money(m.cost)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Chưa có lịch sử</div>') : '',
    inc: d.incidents ? (d.incidents.length ? `<div class="tbl-wrap"><table><thead><tr><th>Ngày</th><th>Sự cố</th><th>Mức độ</th><th>Trạng thái</th><th>Người báo</th></tr></thead><tbody>
      ${d.incidents.map((i) => `<tr><td class="nowrap">${dt(i.created_at)}</td><td><b>${esc(i.title)}</b><div class="small muted">${esc(i.description || '')}</div>${i.resolution ? `<div class="small">✔ ${esc(i.resolution)}</div>` : ''}</td><td>${badge(SEVERITY, i.severity)}</td><td>${badge(INC_STATUS, i.status)}${i.assigned_to_name ? `<div class="small muted">${esc(i.assigned_to_name)}</div>` : ''}</td><td>${esc(i.reported_by_name || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Chưa có sự cố</div>') : '',
    tr: d.transfers.length ? `<div class="tbl-wrap"><table><thead><tr><th>Ngày</th><th>Từ</th><th>Đến</th><th>Lý do</th><th>Trạng thái</th></tr></thead><tbody>${d.transfers.map((t) => `<tr><td>${dt(t.created_at)}</td><td>${esc(t.from_location_name)}</td><td>${esc(t.to_location_name)}</td><td>${esc(t.reason || '')}<div class="small muted">Đề nghị: ${esc(t.requested_by_name || '')}</div></td><td>${badge(TR_STATUS, t.status)}${t.decided_by_name ? `<div class="small muted">${esc(t.decided_by_name)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Chưa có điều chuyển</div>',
    log: d.audit ? `<div class="tbl-wrap"><table><thead><tr><th>Thời gian</th><th>Người thực hiện</th><th>Thao tác</th><th>Chi tiết</th></tr></thead><tbody>${d.audit.map((g) => `<tr><td class="nowrap">${dt(g.created_at)}</td><td>${esc(g.user_name || '')}</td><td>${esc(g.action)}</td><td class="small mono" style="max-width:480px;word-break:break-all">${esc(g.detail || '')}</td></tr>`).join('')}</tbody></table></div>` : '',
  };

  el.innerHTML = `<div class="card"><div class="asset-head">
      <div class="qrbox">${qrSvg(d.qr_url, { ecl: 'Q', scale: 6 })}<div class="small muted" style="margin-top:4px">Quét để mở trên điện thoại</div></div>
      <div class="t"><div class="code">${esc(a.asset_code)}</div><h1 style="margin:2px 0 6px">${esc(a.name)}</h1>
        <div class="row">${badge(STATUS, a.status)} ${crit(a.criticality)} <span class="muted">${esc(a.location_code)} · ${esc(a.location_name)}${a.area ? ' · ' + esc(a.area) : ''}</span></div>
        <div class="row" style="margin-top:12px">${acts.join('')}</div></div></div></div>
    <div class="card"><div class="tabs">${tabs.map(([k, l], i) => `<button data-tab="${k}" class="${i ? '' : 'on'}">${l}</button>`).join('')}</div>
    ${tabs.map(([k], i) => `<div data-pane="${k}" ${i ? 'hidden' : ''}>${panes[k]}</div>`).join('')}</div>`;
  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { $$('[data-tab]', el).forEach((x) => x.classList.toggle('on', x === b)); $$('[data-pane]', el).forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab)); }));
  const reload = async () => { const nd = await GET('/api/assets/' + id); renderAssetDetail(el, nd, { scan }); };
  $$('[data-act]', el).forEach((b) => (b.onclick = () => assetAction(b.dataset.act, a, reload)));
}

async function assetAction(act, a, reload) {
  if (act === 'incident') return incidentModal(a, reload);
  if (act === 'maint') return maintenanceModal(a, reload);
  if (act === 'transfer') {
    return modal({ title: 'Đề nghị điều chuyển ' + a.asset_code, body: `<div class="form">
      ${field({ name: 'to_location_id', label: 'Địa điểm nhận', type: 'select', options: locOptions(false, '— Chọn —'), required: true, cls: 'two' })}
      ${field({ name: 'to_custodian_id', label: 'Người quản lý mới', type: 'select', options: userOptions('— Giữ nguyên / chưa xác định —') })}
      ${field({ name: 'reason', label: 'Lý do', type: 'textarea', cls: 'full' })}
      ${can('transfer.approve') ? field({ name: 'auto_approve', label: 'Duyệt luôn (tôi có quyền duyệt)', type: 'checkbox', cls: 'full' }) : ''}</div>`,
    actions: [{ label: 'Gửi đề nghị', cls: 'primary', onClick: async ({ el, close }) => { await POST(`/api/assets/${a.id}/transfers`, readForm(el)); close(); toast('Đã tạo đề nghị điều chuyển'); reload(); } }] });
  }
  if (act === 'status') {
    return modal({ title: 'Đổi trạng thái', body: `<div class="form">${field({ name: 'status', label: 'Trạng thái mới', type: 'select', value: a.status, options: Object.entries(STATUS).map(([k, [l]]) => [k, l]), cls: 'full' })}</div>`,
      actions: [{ label: 'Lưu', cls: 'primary', onClick: async ({ el, close }) => { await PUT('/api/assets/' + a.id, readForm(el)); close(); toast('Đã cập nhật'); reload(); } }] });
  }
  if (act === 'reqr') {
    if (!(await confirmBox('Cấp lại mã QR sẽ <b>vô hiệu hoá nhãn cũ</b> đang dán trên tài sản. Dùng khi nhãn bị hỏng/mất hoặc nghi bị sao chép. Tiếp tục?'))) return;
    await POST(`/api/assets/${a.id}/regenerate-qr`); toast('Đã cấp mã QR mới – hãy in và dán lại nhãn'); return reload();
  }
  if (act === 'delete') {
    if (!(await confirmBox(`Xoá vĩnh viễn tài sản <b>${esc(a.asset_code)}</b> cùng toàn bộ lịch sử? Nên dùng trạng thái "Đã thanh lý" thay vì xoá.`, 'Xoá', 'danger solid'))) return;
    await DEL('/api/assets/' + a.id); toast('Đã xoá'); go('/assets');
  }
}
function incidentModal(a, reload) {
  modal({ title: 'Báo hỏng / sự cố: ' + a.asset_code, body: `<div class="form">
    ${field({ name: 'title', label: 'Hiện tượng', required: true, cls: 'full', placeholder: 'VD: Tủ không lạnh, kêu to, chảy nước…' })}
    ${field({ name: 'severity', label: 'Mức độ', type: 'select', value: 'normal', options: Object.entries(SEVERITY).map(([k, [l]]) => [k, l]) })}
    ${field({ name: 'mark_broken', label: 'Chuyển trạng thái thành "Hỏng"', type: 'checkbox', cls: 'two' })}
    ${field({ name: 'description', label: 'Mô tả chi tiết (thời điểm phát hiện, nhiệt độ, hàng hoá bị ảnh hưởng…)', type: 'textarea', cls: 'full' })}</div>`,
  actions: [{ label: 'Gửi báo hỏng', cls: 'danger solid', onClick: async ({ el, close }) => { await POST(`/api/assets/${a.id}/incidents`, readForm(el)); close(); toast('Đã gửi báo hỏng tới bộ phận bảo trì'); reload?.(); } }] });
}
function maintenanceModal(a, reload, incident) {
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  modal({ title: 'Ghi nhận bảo trì / sửa chữa: ' + a.asset_code, body: `<div class="form">
    ${field({ name: 'type', label: 'Loại công việc', type: 'select', value: incident ? 'corrective' : 'preventive', options: Object.entries(MT_TYPES) })}
    ${field({ name: 'performed_date', label: 'Ngày thực hiện', type: 'date', value: today, required: true })}
    ${field({ name: 'cost', label: 'Chi phí (đ)', type: 'number', value: 0 })}
    ${field({ name: 'description', label: 'Nội dung công việc', type: 'textarea', required: true, cls: 'full', value: incident ? 'Xử lý: ' + incident.title : '' })}
    ${field({ name: 'result', label: 'Kết quả', placeholder: 'Đạt / Cần thay linh kiện…' })}
    ${field({ name: 'performed_by', label: 'Người thực hiện', value: S.me.full_name })}
    ${field({ name: 'vendor', label: 'Đơn vị ngoài (nếu có)' })}
    ${field({ name: 'ticket_ref', label: 'Số phiếu / ticket Gapo' })}
    ${field({ name: 'set_status', label: 'Trạng thái tài sản sau khi làm', type: 'select', value: '', options: [['', 'Giữ nguyên'], ['in_use', 'Đang sử dụng'], ['under_repair', 'Đang sửa chữa'], ['broken', 'Hỏng chờ xử lý']] })}
    ${can('maintenance.plan') ? field({ name: 'next_maintenance_date', label: 'Bảo trì kế tiếp (để trống = tự tính theo chu kỳ)', type: 'date' }) : ''}
    ${incident ? `<input type="hidden" name="incident_id" value="${incident.id}">${field({ name: 'resolve_incident', label: 'Đóng sự cố này', type: 'checkbox', value: true, cls: 'full' })}` : ''}</div>`,
  actions: [{ label: 'Lưu', cls: 'primary', onClick: async ({ el, close }) => { const f = readForm(el); if (!f.set_status) delete f.set_status; await POST(`/api/assets/${a.id}/maintenance`, f); close(); toast('Đã ghi nhận'); reload?.(); } }] });
}

// ---------------- Form tài sản ----------------
async function pageAssetForm(el, id) {
  const editing = !!id;
  let a = {};
  if (editing) a = (await GET('/api/assets/' + id)).asset;
  else if (!can('asset.create')) throw new Error('Bạn không có quyền thêm tài sản');
  setTitle(editing ? 'Sửa ' + a.asset_code : 'Thêm tài sản mới');
  const gen = editing ? can('asset.update') : true;
  const mt = editing ? can('maintenance.plan') : true;
  const acc = can('accounting.update');
  const showAcc = acc || can('accounting.view');
  const showMt = mt || can('maintenance.view');
  el.innerHTML = `<form id="af">
    <div class="card"><h2>Thông tin chung ${gen ? '' : '<span class="badge">Chỉ xem</span>'}</h2><div class="form">
      ${field({ name: 'name', label: 'Tên tài sản', value: a.name, required: true, cls: 'two', disabled: !gen })}
      ${field({ name: 'asset_code', label: 'Mã tài sản (để trống = tự sinh)', value: a.asset_code, disabled: !gen })}
      ${field({ name: 'category_id', label: 'Loại tài sản', type: 'select', options: catOptions('— Chọn loại —'), value: a.category_id, required: true, disabled: !gen })}
      ${editing ? field({ name: '_loc', label: 'Địa điểm (đổi qua Điều chuyển)', value: `${a.location_code} – ${a.location_name}`, disabled: true }) : field({ name: 'location_id', label: 'Địa điểm', type: 'select', options: locOptions(true, '— Chọn địa điểm —'), required: true })}
      ${field({ name: 'area', label: 'Vị trí đặt trong địa điểm', value: a.area, disabled: !gen, placeholder: 'VD: Khu đông lạnh, quầy thu ngân 1' })}
      ${field({ name: 'custodian_user_id', label: 'Người quản lý tài sản', type: 'select', options: userOptions(), value: a.custodian_user_id, disabled: !gen })}
      ${field({ name: 'brand', label: 'Hãng', value: a.brand, disabled: !gen })}
      ${field({ name: 'model', label: 'Model', value: a.model, disabled: !gen })}
      ${field({ name: 'serial_no', label: 'Số serial', value: a.serial_no, disabled: !gen })}
      ${field({ name: 'purchase_date', label: 'Ngày mua', type: 'date', value: a.purchase_date, disabled: !gen })}
      ${field({ name: 'supplier', label: 'Nhà cung cấp', value: a.supplier, disabled: !gen })}
      ${field({ name: 'invoice_no', label: 'Số hoá đơn', value: a.invoice_no, disabled: !gen })}
      ${!editing || can('asset.status') ? field({ name: 'status', label: 'Trạng thái', type: 'select', value: a.status || 'in_use', options: Object.entries(STATUS).map(([k, [l]]) => [k, l]) }) : ''}
      ${field({ name: 'specs', label: 'Thông số kỹ thuật', type: 'textarea', value: a.specs, cls: 'full', disabled: !gen })}
      ${field({ name: 'notes', label: 'Ghi chú', type: 'textarea', value: a.notes, cls: 'full', disabled: !gen })}
    </div></div>
    ${showMt ? `<div class="card"><h2>Bảo trì & bảo hành ${mt ? '' : '<span class="badge">Chỉ xem</span>'}</h2><div class="form">
      ${field({ name: 'criticality', label: 'Mức độ quan trọng', type: 'select', value: a.criticality || 'B', options: Object.entries(CRIT), disabled: !mt })}
      ${field({ name: 'maintenance_cycle_days', label: 'Chu kỳ bảo trì (ngày, trống = theo loại)', type: 'number', value: a.maintenance_cycle_days, disabled: !mt })}
      ${field({ name: 'next_maintenance_date', label: 'Ngày bảo trì kế tiếp', type: 'date', value: a.next_maintenance_date, disabled: !mt })}
      ${field({ name: 'maintenance_vendor', label: 'Đơn vị bảo trì', value: a.maintenance_vendor, disabled: !mt })}
      ${field({ name: 'warranty_until', label: 'Bảo hành đến ngày', type: 'date', value: a.warranty_until, disabled: !mt })}
      ${field({ name: 'warranty_provider', label: 'Đơn vị bảo hành', value: a.warranty_provider, disabled: !mt })}
      ${field({ name: 'warranty_contact', label: 'Liên hệ bảo hành (SĐT/hotline)', value: a.warranty_contact, disabled: !mt, cls: 'full' })}
    </div></div>` : ''}
    ${showAcc ? `<div class="card"><h2>Thông tin kế toán ${acc ? '' : '<span class="badge">Chỉ xem</span>'}</h2><div class="form">
      ${field({ name: 'accounting_code', label: 'Mã TS trên phần mềm kế toán', value: a.accounting_code, disabled: !acc })}
      ${field({ name: 'accounting_type', label: 'Phân loại', type: 'select', value: a.accounting_type || '', options: [['', '—'], ['TSCD', 'Tài sản cố định'], ['CCDC', 'Công cụ dụng cụ'], ['KHAC', 'Khác']], disabled: !acc })}
      ${field({ name: 'accounting_account', label: 'Tài khoản (211, 242, 153…)', value: a.accounting_account, disabled: !acc })}
      ${field({ name: 'original_cost', label: 'Nguyên giá (đ)', type: 'number', value: a.original_cost, disabled: !acc })}
      ${field({ name: 'useful_life_months', label: 'Thời gian khấu hao/phân bổ (tháng)', type: 'number', value: a.useful_life_months, disabled: !acc })}
      ${field({ name: 'in_service_date', label: 'Ngày đưa vào sử dụng', type: 'date', value: a.in_service_date, disabled: !acc })}
      ${field({ name: 'cost_center', label: 'Trung tâm chi phí', value: a.cost_center, disabled: !acc })}
    </div></div>` : ''}
    <div class="row end"><a class="btn" href="${editing ? '/assets/' + id : '/assets'}">Huỷ</a><button class="btn primary">💾 Lưu tài sản</button></div></form>`;
  $('#af', el).onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm(e.target);
    delete f._loc;
    try {
      const r = editing ? await PUT('/api/assets/' + id, f) : await POST('/api/assets', f);
      toast('Đã lưu ' + r.asset.asset_code);
      go('/assets/' + r.asset.id);
    } catch (err) { toast(err.message, true); }
  };
}

// ---------------- Trang quét QR (tối ưu điện thoại) ----------------
async function pageScan(el, token) {
  document.title = 'Thông tin tài sản';
  el.innerHTML = '<div class="scan"><div class="muted">Đang tải…</div></div>';
  if (S.me === null && !S._tried) { S._tried = true; await loadSession(); }
  let d;
  try { d = await GET('/api/scan/' + token); } catch (e) { el.innerHTML = `<div class="scan"><div class="alert bad">${esc(e.message)}</div></div>`; return; }
  const box = $('.scan', el);
  const loginLink = `/login?next=${encodeURIComponent(location.pathname)}`;
  if (d.login_required) { box.innerHTML = `<div class="alert">Vui lòng đăng nhập để xem tài sản.</div><a class="btn primary" href="${loginLink}">Đăng nhập</a>`; return; }
  const a = d.asset;
  const header = `<div class="hero"><div class="row"><img src="/brand/logo-mark-white.png" alt="" style="height:30px"><b style="flex:1">${esc(S.cfg.companyShort || '')} · Tài sản</b>${S.me ? `<a href="/" style="color:#cdeedd">Mở hệ thống ›</a>` : ''}</div>
    <div class="code" style="margin-top:10px">${esc(a.asset_code)}</div><h1>${esc(a.name)}</h1><div>${badge(STATUS, a.status)} <span style="opacity:.85">${esc(a.location_code)} · ${esc(a.location_name)}</span></div></div>`;
  if (d.mode !== 'full') {
    box.innerHTML = header + `<div class="card"><dl class="kv"><dt>Loại</dt><dd>${esc(a.category_name)}</dd><dt>Vị trí</dt><dd>${esc(a.area || '—')}</dd>${a.hotline ? `<dt>Hotline bảo trì</dt><dd><a href="tel:${esc(a.hotline)}">${esc(a.hotline)}</a></dd>` : ''}</dl></div>
      ${S.me ? '<div class="alert warn">Tài sản này không thuộc phạm vi địa điểm của bạn nên chỉ hiển thị thông tin cơ bản.</div>' : `<a class="btn primary" style="width:100%;justify-content:center;padding:12px" href="${loginLink}">Đăng nhập để xem đầy đủ / báo hỏng</a>`}`;
    return;
  }
  box.innerHTML = header + `<div class="actions">${d.can_report ? '<button class="btn danger solid" data-act="incident">🚨 Báo hỏng</button>' : ''}${can('maintenance.create') ? '<button class="btn teal" data-act="maint">🛠️ Ghi bảo trì</button>' : ''}
    <a class="btn" href="/assets/${d.id}">📄 Xem chi tiết</a>${a.custodian_phone ? `<a class="btn" href="tel:${esc(a.custodian_phone)}">📞 Gọi người quản lý</a>` : ''}</div><div id="detail"></div>`;
  const sections = [];
  sections.push(['👤 Người quản lý & vị trí', [['Người quản lý', esc(a.custodian_name || '—')], ['Điện thoại', a.custodian_phone ? `<a href="tel:${esc(a.custodian_phone)}">${esc(a.custodian_phone)}</a>` : '—'], ['Vị trí đặt', esc(a.area || '—')], ['Hãng/Model', esc([a.brand, a.model].filter(Boolean).join(' / ') || '—')], ['Serial', esc(a.serial_no || '—')]]]);
  if (d.maintenance) sections.push(['🛠️ Bảo trì & bảo hành', [['Mức quan trọng', crit(a.criticality)], ['Bảo trì gần nhất', dmy(a.last_maintenance_date) || '—'], ['Bảo trì kế tiếp', a.next_maintenance_date ? `<span class="badge ${a.maintenance_due === 'overdue' ? 'bad' : a.maintenance_due === 'soon' ? 'warn' : 'ok'}">${dmy(a.next_maintenance_date)}</span>` : '—'], ['Đơn vị bảo trì', esc(a.maintenance_vendor || '—')], ['Bảo hành', a.warranty_until ? `${dmy(a.warranty_until)} ${a.warranty_active ? '<span class="badge ok">Còn BH</span>' : '<span class="badge">Hết BH</span>'}` : '—'], ['Liên hệ BH', esc([a.warranty_provider, a.warranty_contact].filter(Boolean).join(' · ') || '—')]]]);
  if ('original_cost' in a) sections.push(['💰 Kế toán', [['Mã TS kế toán', esc(a.accounting_code || '—')], ['Nguyên giá', money(a.original_cost) || '—'], ['Ngày mua', dmy(a.purchase_date) || '—'], ['Nhà cung cấp', esc(a.supplier || '—')], ['Giá trị còn lại', a.depreciation ? money(a.depreciation.remaining_value) : '—']]]);
  const open = (d.incidents || []).filter((i) => ['open', 'in_progress'].includes(i.status));
  let html = sections.map(([t, rows]) => `<div class="card"><h2>${t}</h2><dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`).join('');
  if (open.length) html = `<div class="card"><h2>🚨 Sự cố đang mở</h2>${open.map((i) => `<div style="margin-bottom:8px">${badge(SEVERITY, i.severity)} <b>${esc(i.title)}</b><div class="small muted">${dt(i.created_at)} · ${esc(i.reported_by_name || '')} · ${INC_STATUS[i.status][0]}</div></div>`).join('')}</div>` + html;
  if (d.maintenance?.length) html += `<div class="card"><h2>Lịch sử bảo trì gần đây</h2>${d.maintenance.slice(0, 5).map((m) => `<div style="margin-bottom:8px"><b>${dmy(m.performed_date)}</b> · ${esc(MT_TYPES[m.type])}<div class="small">${esc(m.description)}</div></div>`).join('')}</div>`;
  $('#detail', box).innerHTML = html;
  const reload = () => pageScan(el, token);
  $$('[data-act]', box).forEach((b) => (b.onclick = () => (b.dataset.act === 'incident' ? incidentModal({ ...a, id: d.id }, reload) : maintenanceModal({ ...a, id: d.id }, reload))));
}

// ---------------- Bảo trì ----------------
async function pageMaintenance(el) {
  setTitle('Bảo trì & kế hoạch năm');
  const tab = new URLSearchParams(location.search).get('tab') || 'due';
  el.innerHTML = `<div class="tabs no-print">${[['due', 'Đến hạn / quá hạn'], ['plan', 'Kế hoạch bảo trì năm'], ['history', 'Lịch sử thực hiện']].map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-t="${k}">${l}</button>`).join('')}</div><div id="mt"></div>`;
  $$('[data-t]', el).forEach((b) => (b.onclick = () => go('/maintenance?tab=' + b.dataset.t)));
  const box = $('#mt', el);
  if (tab === 'due') {
    const draw = async (f) => {
      const d = await GET('/api/maintenance/schedule?' + qs(f));
      $('#res', box).innerHTML = d.items.length ? `<table><thead><tr><th>Hạn</th><th>Mã</th><th>Tài sản</th><th>Địa điểm</th><th>QT</th><th class="hide-m">Bảo trì gần nhất</th><th class="hide-m">Chu kỳ</th><th></th></tr></thead><tbody>
        ${d.items.map((r) => `<tr class="clickable" data-go="/assets/${r.id}"><td class="nowrap"><span class="badge ${r.overdue_days ? 'bad' : 'warn'}">${dmy(r.next_maintenance_date)}</span>${r.overdue_days ? `<div class="small" style="color:var(--bad)">trễ ${r.overdue_days} ngày</div>` : ''}</td>
        <td class="mono">${esc(r.asset_code)}</td><td>${esc(r.name)}<div class="small muted">${esc(r.category_name)}</div></td><td>${esc(r.location_code)}</td><td>${crit(r.criticality)}</td><td class="hide-m">${dmy(r.last_maintenance_date)}</td><td class="hide-m">${r.maintenance_cycle_days} ngày</td>
        <td>${can('maintenance.create') ? `<button class="btn sm teal" data-m="${r.id}">Ghi bảo trì</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Không có tài sản đến hạn 🎉</div>';
      clickRows(box);
      $$('[data-m]', box).forEach((b) => (b.onclick = () => maintenanceModal(d.items.find((x) => x.id == b.dataset.m), () => draw(f))));
    };
    box.innerHTML = `<div class="card"><form class="row" id="f">${field({ name: 'days', label: 'Trong vòng', type: 'select', value: 30, options: [[7, '7 ngày'], [30, '30 ngày'], [60, '60 ngày'], [90, '90 ngày']] })}
      ${field({ name: 'location_id', label: 'Địa điểm', type: 'select', options: locOptions() })}${field({ name: 'group', label: 'Nhóm', type: 'select', options: groupOptions() })}</form></div><div class="card flush tbl-wrap" id="res"></div>`;
    $('#f', box).onchange = (e) => draw(readForm(e.currentTarget));
    return draw({ days: 30 });
  }
  if (tab === 'plan') {
    const y = new Date().getFullYear();
    const draw = async (f) => {
      const d = await GET('/api/maintenance/plan?' + qs(f));
      const curM = new Date().getFullYear() === d.year ? new Date().getMonth() : d.year < new Date().getFullYear() ? 12 : -1;
      const cell = (m, i) => {
        const p = m.planned.length, dn = m.done.length;
        if (!p && !dn) return '';
        const late = i < curM && dn < p;
        return `<span class="p ${dn >= p && dn ? 'd' : ''} ${late ? 'late' : ''}" title="Kế hoạch: ${m.planned.map(dmy).join(', ')}${dn ? '\nĐã làm: ' + m.done.map(dmy).join(', ') : ''}">${dn ? '●' : '○'}${Math.max(p, dn) > 1 ? Math.max(p, dn) : ''}</span>`;
      };
      $('#res', box).innerHTML = `<h2 style="padding:14px 16px 0">KẾ HOẠCH BẢO TRÌ NĂM ${d.year} – ${esc(S.cfg.companyName || '')}</h2>
        <p class="muted small" style="padding:0 16px">○ kế hoạch · ● đã thực hiện · <span style="color:var(--bad)">viền đỏ</span> = quá hạn chưa làm · ${d.items.length} thiết bị có chu kỳ</p>
        <div class="tbl-wrap"><table class="plan"><thead><tr><th>Địa điểm</th><th>Mã</th><th>Thiết bị</th><th>Chu kỳ</th>${Array.from({ length: 12 }, (_, i) => `<th class="m">T${i + 1}</th>`).join('')}</tr></thead><tbody>
        ${d.items.map((r) => `<tr><td>${esc(r.location_code)}</td><td class="mono small"><a href="/assets/${r.id}">${esc(r.asset_code)}</a></td><td>${esc(r.name)} ${crit(r.criticality)}</td><td class="nowrap">${r.maintenance_cycle_days}n</td>${r.months.map((m, i) => `<td class="m">${cell(m, i)}</td>`).join('')}</tr>`).join('')}
        <tr class="tot"><td colspan="4">Tổng (đã làm / kế hoạch)</td>${d.totals.map((t) => `<td class="m">${t.done}/${t.planned}</td>`).join('')}</tr></tbody></table></div>`;
    };
    box.innerHTML = `<div class="card no-print"><form class="row" id="f">${field({ name: 'year', label: 'Năm', type: 'select', value: y, options: [y - 1, y, y + 1].map((x) => [x, x]) })}
      ${field({ name: 'location_id', label: 'Địa điểm', type: 'select', options: locOptions() })}${field({ name: 'group', label: 'Nhóm', type: 'select', options: groupOptions() })}
      <button type="button" class="btn" id="btn-print-plan" style="margin-top:18px">🖨️ In kế hoạch</button></form></div><div class="card flush" id="res"></div>`;
    $('#btn-print-plan', box).onclick = () => window.print();
    $('#f', box).onchange = (e) => draw(readForm(e.currentTarget));
    return draw({ year: y });
  }
  const draw = async (f) => {
    const d = await GET('/api/maintenance/records?' + qs(f));
    $('#res', box).innerHTML = `<div style="padding:10px 14px" class="muted">${d.items.length} lượt · Tổng chi phí: <b>${money(d.total_cost)}</b></div>` + (d.items.length ? `<table><thead><tr><th>Ngày</th><th>Tài sản</th><th>Địa điểm</th><th>Loại</th><th>Nội dung</th><th>Thực hiện</th><th class="right">Chi phí</th></tr></thead><tbody>
      ${d.items.map((m) => `<tr class="clickable" data-go="/assets/${m.asset_id}"><td class="nowrap">${dmy(m.performed_date)}</td><td><span class="mono small">${esc(m.asset_code)}</span><div>${esc(m.asset_name)}</div></td><td>${esc(m.location_code)}</td><td>${esc(MT_TYPES[m.type])}</td><td>${esc(m.description)}</td><td>${esc(m.performed_by || '')}</td><td class="right nowrap">${money(m.cost)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Chưa có dữ liệu</div>');
    clickRows(box);
  };
  const first = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 8) + '01';
  box.innerHTML = `<div class="card"><form class="row" id="f">${field({ name: 'from', label: 'Từ ngày', type: 'date', value: first })}${field({ name: 'to', label: 'Đến ngày', type: 'date' })}
    ${field({ name: 'type', label: 'Loại', type: 'select', options: [['', 'Tất cả'], ...Object.entries(MT_TYPES)] })}${field({ name: 'location_id', label: 'Địa điểm', type: 'select', options: locOptions() })}</form></div><div class="card flush tbl-wrap" id="res"></div>`;
  $('#f', box).onchange = (e) => draw(readForm(e.currentTarget));
  draw({ from: first });
}

// ---------------- Sự cố ----------------
async function pageIncidents(el) {
  setTitle('Sự cố / báo hỏng');
  const status = new URLSearchParams(location.search).get('status') || 'active';
  el.innerHTML = `<div class="tabs">${[['active', 'Đang mở'], ['resolved', 'Đã xử lý'], ['cancelled', 'Đã huỷ']].map(([k, l]) => `<button class="${k === status ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}</div><div class="card flush tbl-wrap" id="res"></div>`;
  $$('[data-s]', el).forEach((b) => (b.onclick = () => go('/incidents?status=' + b.dataset.s)));
  const draw = async () => {
    const d = await GET('/api/incidents?status=' + status);
    const mg = can('incident.manage');
    $('#res', el).innerHTML = d.items.length ? `<table><thead><tr><th>Thời gian</th><th>Tài sản</th><th>Địa điểm</th><th>Sự cố</th><th>Mức độ</th><th>Trạng thái</th><th>Người báo</th>${mg ? '<th></th>' : ''}</tr></thead><tbody>
      ${d.items.map((i) => `<tr><td class="nowrap">${dt(i.created_at)}</td><td><a class="mono small" href="/assets/${i.asset_id}">${esc(i.asset_code)}</a><div>${esc(i.asset_name)} ${crit(i.criticality)}</div></td><td>${esc(i.location_code)}</td>
        <td><b>${esc(i.title)}</b><div class="small muted">${esc(i.description || '')}</div>${i.resolution ? `<div class="small">✔ ${esc(i.resolution)}</div>` : ''}</td><td>${badge(SEVERITY, i.severity)}</td>
        <td>${badge(INC_STATUS, i.status)}${i.assigned_to_name ? `<div class="small muted">→ ${esc(i.assigned_to_name)}</div>` : ''}</td><td>${esc(i.reported_by_name || '')}${i.reported_by_phone ? `<div class="small"><a href="tel:${esc(i.reported_by_phone)}">${esc(i.reported_by_phone)}</a></div>` : ''}</td>
        ${mg ? `<td class="nowrap">${['open', 'in_progress'].includes(i.status) ? `<button class="btn sm" data-assign="${i.id}">Tiếp nhận</button> <button class="btn sm teal" data-fix="${i.id}">Xử lý xong</button> <button class="btn sm danger" data-cancel="${i.id}">Huỷ</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table>` : '<div class="empty">Không có sự cố</div>';
    const find = (id) => d.items.find((x) => x.id == id);
    $$('[data-assign]', el).forEach((b) => (b.onclick = () => modal({ title: 'Tiếp nhận sự cố', body: `<div class="form">${field({ name: 'assigned_to', label: 'Giao cho', type: 'select', options: userOptions('— Chọn —'), value: S.me.id, cls: 'full' })}</div>`,
      actions: [{ label: 'Lưu', cls: 'primary', onClick: async ({ el: m, close }) => { await PUT('/api/incidents/' + b.dataset.assign, { ...readForm(m), status: 'in_progress' }); close(); draw(); } }] })));
    $$('[data-fix]', el).forEach((b) => (b.onclick = () => { const i = find(b.dataset.fix); maintenanceModal({ id: i.asset_id, asset_code: i.asset_code }, draw, i); }));
    $$('[data-cancel]', el).forEach((b) => (b.onclick = async () => { if (await confirmBox('Huỷ sự cố này (báo nhầm/trùng)?')) { await PUT('/api/incidents/' + b.dataset.cancel, { status: 'cancelled' }); draw(); } }));
  };
  draw();
}

// ---------------- Điều chuyển ----------------
async function pageTransfers(el) {
  setTitle('Điều chuyển tài sản');
  const d = await GET('/api/transfers');
  el.innerHTML = `<div class="alert">Để tạo đề nghị điều chuyển, mở chi tiết tài sản và bấm <b>🔁 Điều chuyển</b>.</div><div class="card flush tbl-wrap">${d.items.length ? `<table><thead><tr><th>Ngày</th><th>Tài sản</th><th>Từ</th><th>Đến</th><th>Lý do</th><th>Trạng thái</th><th></th></tr></thead><tbody>
    ${d.items.map((t) => `<tr><td class="nowrap">${dt(t.created_at)}</td><td><a class="mono small" href="/assets/${t.asset_id}">${esc(t.asset_code)}</a><div>${esc(t.asset_name)}</div></td><td>${esc(t.from_code)}</td><td>${esc(t.to_code)}${t.to_custodian_name ? `<div class="small muted">→ ${esc(t.to_custodian_name)}</div>` : ''}</td>
      <td>${esc(t.reason || '')}<div class="small muted">Đề nghị: ${esc(t.requested_by_name || '')}</div></td><td>${badge(TR_STATUS, t.status)}${t.decided_by_name ? `<div class="small muted">${esc(t.decided_by_name)}${t.decision_note ? ': ' + esc(t.decision_note) : ''}</div>` : ''}</td>
      <td class="nowrap">${t.status === 'pending' ? `${can('transfer.approve') ? `<button class="btn sm teal" data-ok="${t.id}">Duyệt</button> <button class="btn sm danger" data-no="${t.id}">Từ chối</button>` : ''} ${t.requested_by === S.me.id ? `<button class="btn sm" data-cc="${t.id}">Huỷ</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Chưa có đề nghị điều chuyển</div>'}</div>`;
  const decide = (id, approve) => modal({ title: approve ? 'Duyệt điều chuyển' : 'Từ chối điều chuyển', body: field({ name: 'note', label: 'Ghi chú', type: 'textarea' }),
    actions: [{ label: approve ? 'Duyệt' : 'Từ chối', cls: approve ? 'primary' : 'danger solid', onClick: async ({ el: m, close }) => { await POST(`/api/transfers/${id}/decide`, { approve, ...readForm(m) }); close(); toast('Đã xử lý'); pageTransfers(el); } }] });
  $$('[data-ok]', el).forEach((b) => (b.onclick = () => decide(b.dataset.ok, true)));
  $$('[data-no]', el).forEach((b) => (b.onclick = () => decide(b.dataset.no, false)));
  $$('[data-cc]', el).forEach((b) => (b.onclick = async () => { await POST(`/api/transfers/${b.dataset.cc}/cancel`); pageTransfers(el); }));
}

// ---------------- Địa điểm ----------------
async function pageLocations(el) {
  setTitle('Địa điểm', can('location.manage') ? '<button class="btn primary" id="add">➕ Thêm địa điểm</button>' : '');
  const d = await GET('/api/locations');
  el.innerHTML = `<div class="card flush tbl-wrap"><table><thead><tr><th>Mã</th><th>Tên</th><th>Loại</th><th>Khu vực</th><th>Địa chỉ</th><th>Phụ trách</th><th class="right">Tài sản</th><th>Hoạt động</th></tr></thead><tbody>
    ${d.items.map((l) => `<tr class="clickable" data-id="${l.id}"><td class="mono">${esc(l.code)}</td><td><b>${esc(l.name)}</b></td><td>${esc(LOC_TYPES[l.type])}</td><td>${esc(l.region || '')}</td><td>${esc(l.address || '')}</td><td>${esc(l.manager_name || '')}${l.phone ? `<div class="small">${esc(l.phone)}</div>` : ''}</td><td class="right"><a href="/assets?location_id=${l.id}">${l.asset_count}</a></td><td>${l.active ? '<span class="badge ok">Có</span>' : '<span class="badge">Ngừng</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  const edit = (l = { type: 'store', active: 1 }) => {
    if (!can('location.manage')) return;
    modal({ title: l.id ? 'Sửa địa điểm' : 'Thêm địa điểm', body: `<div class="form">${field({ name: 'code', label: 'Mã', value: l.code, required: true })}${field({ name: 'name', label: 'Tên', value: l.name, required: true, cls: 'two' })}
      ${field({ name: 'type', label: 'Loại', type: 'select', value: l.type, options: Object.entries(LOC_TYPES) })}${field({ name: 'region', label: 'Khu vực / vùng', value: l.region })}${field({ name: 'phone', label: 'Điện thoại', value: l.phone })}
      ${field({ name: 'address', label: 'Địa chỉ', value: l.address, cls: 'two' })}${field({ name: 'manager_user_id', label: 'Người phụ trách', type: 'select', options: userOptions('—'), value: l.manager_user_id })}
      ${field({ name: 'active', label: 'Đang hoạt động', type: 'checkbox', value: l.active })}</div>`,
    actions: [{ label: 'Lưu', cls: 'primary', onClick: async ({ el: m, close }) => { const f = readForm(m); l.id ? await PUT('/api/locations/' + l.id, f) : await POST('/api/locations', f); close(); S.lookups = await GET('/api/lookups'); pageLocations(el); } }] });
  };
  $$('[data-id]', el).forEach((r) => r.addEventListener('click', (e) => { if (!e.target.closest('a')) edit(d.items.find((x) => x.id == r.dataset.id)); }));
  $('#add')?.addEventListener('click', () => edit());
}

// ---------------- Loại tài sản ----------------
async function pageCategories(el) {
  setTitle('Loại tài sản', '<button class="btn primary" id="add">➕ Thêm loại</button>');
  const list = S.lookups.categories;
  el.innerHTML = `<div class="card flush tbl-wrap"><table><thead><tr><th>Mã</th><th>Tên loại</th><th>Nhóm</th><th class="right">Chu kỳ bảo trì</th><th class="right">Thời gian sử dụng</th><th>Dán QR</th><th>Hoạt động</th></tr></thead><tbody>
    ${list.map((c) => `<tr class="clickable" data-id="${c.id}"><td class="mono">${esc(c.code)}</td><td>${esc(c.name)}</td><td>${esc(c.grp)}</td><td class="right">${c.maintenance_cycle_days ? c.maintenance_cycle_days + ' ngày' : '—'}</td><td class="right">${c.useful_life_months ? c.useful_life_months + ' tháng' : '—'}</td><td>${c.label_qr ? '✔' : ''}</td><td>${c.active ? '✔' : ''}</td></tr>`).join('')}</tbody></table></div>`;
  const edit = (c = { active: 1, label_qr: 1 }) => modal({ title: c.id ? 'Sửa loại tài sản' : 'Thêm loại tài sản', body: `<div class="form">${field({ name: 'code', label: 'Mã (VD: TU_DONG)', value: c.code, required: true })}${field({ name: 'name', label: 'Tên', value: c.name, required: true })}
    ${field({ name: 'grp', label: 'Nhóm', value: c.grp, required: true, attrs: 'list="grps"' })}<datalist id="grps">${[...new Set(list.map((x) => x.grp))].map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    ${field({ name: 'maintenance_cycle_days', label: 'Chu kỳ bảo trì mặc định (ngày)', type: 'number', value: c.maintenance_cycle_days })}${field({ name: 'useful_life_months', label: 'Thời gian sử dụng (tháng)', type: 'number', value: c.useful_life_months })}
    ${field({ name: 'label_qr', label: 'Dán nhãn QR', type: 'checkbox', value: c.label_qr })}${field({ name: 'active', label: 'Đang dùng', type: 'checkbox', value: c.active })}</div>`,
  actions: [{ label: 'Lưu', cls: 'primary', onClick: async ({ el: m, close }) => { const f = readForm(m); c.id ? await PUT('/api/categories/' + c.id, f) : await POST('/api/categories', f); close(); S.lookups = await GET('/api/lookups'); pageCategories(el); } }] });
  $$('[data-id]', el).forEach((r) => (r.onclick = () => edit(list.find((x) => x.id == r.dataset.id))));
  $('#add').onclick = () => edit();
}

// ---------------- Người dùng ----------------
async function pageUsers(el) {
  setTitle('Người dùng', can('user.manage') ? '<button class="btn primary" id="add">➕ Thêm người dùng</button>' : '');
  const q = Object.fromEntries(new URLSearchParams(location.search));
  const [d, roles] = await Promise.all([GET('/api/users?' + qs(q)), GET('/api/roles')]);
  el.innerHTML = `<div class="card"><form class="filters" id="f" style="grid-template-columns:2fr 1fr 1fr 1fr">${field({ name: 'q', label: 'Tìm', value: q.q, placeholder: 'Tên, email, SĐT, mã NV' })}
    ${field({ name: 'role_id', label: 'Chức danh', type: 'select', value: q.role_id, options: [['', 'Tất cả'], ...roles.items.map((r) => [r.id, r.name])] })}
    ${field({ name: 'location_id', label: 'Địa điểm', type: 'select', value: q.location_id, options: locOptions(false) })}
    ${field({ name: 'status', label: 'Trạng thái', type: 'select', value: q.status, options: [['', 'Tất cả'], ['active', 'Hoạt động'], ['locked', 'Đã khoá']] })}</form></div>
    <div class="card flush tbl-wrap"><table><thead><tr><th>Họ tên</th><th>Đăng nhập</th><th>Chức danh</th><th>Phạm vi địa điểm</th><th>Ngoại lệ quyền</th><th>Đăng nhập gần nhất</th><th>Trạng thái</th></tr></thead><tbody>
    ${d.items.map((u) => `<tr class="clickable" data-id="${u.id}"><td><b>${esc(u.full_name)}</b><div class="small muted">${esc(u.employee_code || '')} ${esc(u.department || '')}</div></td><td class="small">${esc(u.email || '')}<div>${esc(u.phone || '')}</div></td>
      <td>${esc(u.role_name)}</td><td class="small">${u.all_locations || u.role_all ? '<span class="badge teal">Toàn hệ thống</span>' : esc(u.location_codes || '— chưa giao —')}</td><td>${u.override_count ? `<span class="badge info">${u.override_count}</span>` : ''}</td><td class="small">${dt(u.last_login_at)}</td><td>${u.status === 'active' ? '<span class="badge ok">Hoạt động</span>' : '<span class="badge bad">Khoá</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  $('#f', el).onchange = (e) => go('/users?' + qs(readForm(e.currentTarget)));
  $$('[data-id]', el).forEach((r) => (r.onclick = () => userModal(Number(r.dataset.id), roles.items, () => pageUsers(el))));
  $('#add')?.addEventListener('click', () => userModal(null, roles.items, () => pageUsers(el)));
}

async function userModal(id, roles, reload) {
  const [perms, info] = await Promise.all([GET('/api/permissions'), id ? GET('/api/users/' + id) : null]);
  const u = info?.user || { status: 'active', role_id: roles.find((r) => r.code === 'NV_CH')?.id };
  const locIds = new Set(info?.location_ids || []);
  const ov = info?.overrides || {};
  const ro = !can('user.manage');
  const groups = {};
  for (const p of perms.items) (groups[p.module] ||= []).push(p);
  const locs = S.lookups.locations;
  const body = `<div class="form">
    ${field({ name: 'full_name', label: 'Họ tên', value: u.full_name, required: true, cls: 'two', disabled: ro })}${field({ name: 'employee_code', label: 'Mã nhân viên', value: u.employee_code, disabled: ro })}
    ${field({ name: 'email', label: 'Email đăng nhập (Gmail)', type: 'email', value: u.email, disabled: ro })}${field({ name: 'phone', label: 'Số điện thoại đăng nhập', value: u.phone, disabled: ro })}${field({ name: 'department', label: 'Bộ phận', value: u.department, disabled: ro })}
    ${field({ name: 'role_id', label: 'Chức danh / vị trí', type: 'select', value: u.role_id, options: roles.map((r) => [r.id, r.name + (r.all_locations ? ' (toàn hệ thống)' : '')]), required: true, disabled: ro })}
    ${field({ name: 'status', label: 'Trạng thái', type: 'select', value: u.status, options: [['active', 'Hoạt động'], ['locked', 'Khoá']], disabled: ro })}
    ${field({ name: 'all_locations', label: 'Xem/thao tác mọi địa điểm', type: 'checkbox', value: u.all_locations, disabled: ro })}
    ${!id && !ro ? field({ name: 'password', label: 'Mật khẩu ban đầu (để trống = tự sinh)', type: 'text', cls: 'full' }) : ''}
  </div>
  <h3>Phạm vi địa điểm <span class="muted small" style="text-transform:none">(bỏ qua nếu chức danh/người dùng có phạm vi toàn hệ thống)</span></h3>
  ${ro ? '' : '<div class="row" style="margin-bottom:6px"><button type="button" class="btn sm" data-sel="store">Chọn tất cả cửa hàng</button><button type="button" class="btn sm" data-sel="wh">Chọn VP + các kho</button><button type="button" class="btn sm" data-sel="none">Bỏ chọn</button></div>'}
  <div class="loc-grid">${locs.map((l) => `<label><input type="checkbox" class="loc" data-type="${l.type}" value="${l.id}" ${locIds.has(l.id) ? 'checked' : ''} ${ro ? 'disabled' : ''}> ${esc(l.code)}</label>`).join('')}</div>
  <h3>Quyền theo người dùng <span class="muted small" style="text-transform:none">(mặc định theo chức danh; có thể cấp thêm hoặc thu hồi từng thao tác)</span></h3>
  <div id="perm-list"></div>
  ${info ? `<h3>Phiên đăng nhập đang hoạt động</h3>${info.sessions.length ? info.sessions.map((s) => `<div class="small">${dt(s.created_at)} · ${esc(s.method)} · ${esc(s.ip || '')}</div>`).join('') : '<div class="small muted">Không có</div>'}` : ''}`;
  const actions = ro ? [] : [{ label: 'Lưu', cls: 'primary', onClick: async ({ el, close }) => {
    const f = readForm($('.form', el));
    f.location_ids = $$('.loc:checked', el).map((c) => Number(c.value));
    f.overrides = Object.fromEntries($$('[data-ov]', el).filter((s) => s.value).map((s) => [s.dataset.ov, s.value]));
    const r = id ? await PUT('/api/users/' + id, f) : await POST('/api/users', f);
    close(); reload();
    if (r.temp_password) showTempPw(f.full_name, f.email || f.phone, r.temp_password); else toast('Đã lưu');
  } }];
  if (id && !ro) actions.unshift({ label: '🔑 Đặt lại mật khẩu', onClick: async () => { if (!(await confirmBox('Đặt lại mật khẩu và đăng xuất mọi phiên của người này?'))) return; const r = await POST(`/api/users/${id}/reset-password`); showTempPw(u.full_name, u.email || u.phone, r.temp_password); } });
  const m = modal({ title: id ? 'Người dùng: ' + u.full_name : 'Thêm người dùng', body, wide: true, actions });
  const drawPerms = () => {
    const role = roles.find((r) => r.id == $('[name=role_id]', m.el).value);
    const rp = new Set(role?.permissions || []);
    const cur = Object.fromEntries($$('[data-ov]', m.el).map((s) => [s.dataset.ov, s.value]));
    const val = (code) => (code in cur ? cur[code] : ov[code] || '');
    $('#perm-list', m.el).innerHTML = Object.entries(groups).map(([g, list]) => `<div class="perm-group"><div>${esc(g)}</div>${list.map((p) => {
      const v = val(p.code);
      const eff = v === 'grant' || (rp.has(p.code) && v !== 'deny');
      return `<div class="perm-item"><span style="width:18px">${eff ? '✅' : '▫️'}</span><span>${esc(p.name)}</span><span class="code">${p.code}</span>
        <select data-ov="${p.code}" ${ro ? 'disabled' : ''}><option value="">${rp.has(p.code) ? 'Mặc định: Có' : 'Mặc định: Không'}</option><option value="grant" ${v === 'grant' ? 'selected' : ''}>Cấp thêm</option><option value="deny" ${v === 'deny' ? 'selected' : ''}>Thu hồi</option></select></div>`;
    }).join('')}</div>`).join('');
    $$('[data-ov]', m.el).forEach((s) => (s.onchange = drawPerms));
  };
  drawPerms();
  $('[name=role_id]', m.el).addEventListener('change', drawPerms);
  $$('[data-sel]', m.el).forEach((b) => (b.onclick = () => $$('.loc', m.el).forEach((c) => { c.checked = b.dataset.sel === 'store' ? c.dataset.type === 'store' || c.checked : b.dataset.sel === 'wh' ? c.dataset.type !== 'store' || c.checked : false; })));
}
function showTempPw(name, login, pw) {
  modal({ title: 'Mật khẩu tạm thời', body: `<div class="alert warn">Mật khẩu chỉ hiển thị <b>một lần</b>. Hãy gửi riêng cho người dùng; họ sẽ phải đổi mật khẩu khi đăng nhập lần đầu.</div>
    <dl class="kv"><dt>Người dùng</dt><dd>${esc(name)}</dd><dt>Đăng nhập</dt><dd>${esc(login)}</dd><dt>Mật khẩu</dt><dd class="mono" style="font-size:18px">${esc(pw)}</dd></dl>
    <p class="small muted">Người dùng cũng có thể đăng nhập bằng OTP qua SĐT hoặc Google (nếu email là Gmail và hệ thống đã bật Google Sign-In).</p>` });
}

// ---------------- Chức danh & phân quyền ----------------
async function pageRoles(el) {
  setTitle('Chức danh & phân quyền', '<button class="btn primary" id="add">➕ Thêm chức danh</button>');
  const [roles, perms] = await Promise.all([GET('/api/roles'), GET('/api/permissions')]);
  const tab = new URLSearchParams(location.search).get('tab') || 'list';
  el.innerHTML = `<div class="tabs"><button data-t="list" class="${tab === 'list' ? 'on' : ''}">Danh sách chức danh</button><button data-t="matrix" class="${tab === 'matrix' ? 'on' : ''}">Ma trận phân quyền</button></div><div id="rb"></div>`;
  $$('[data-t]', el).forEach((b) => (b.onclick = () => go('/roles?tab=' + b.dataset.t)));
  const box = $('#rb', el);
  if (tab === 'matrix') {
    box.innerHTML = `<div class="card flush tbl-wrap"><table class="matrix"><thead><tr><th>Thao tác nghiệp vụ</th>${roles.items.map((r) => `<th class="rot">${esc(r.name)}</th>`).join('')}</tr></thead><tbody>
      <tr><td><b>Phạm vi: toàn hệ thống</b></td>${roles.items.map((r) => `<td class="c">${r.all_locations ? '<span class="yes">●</span>' : '<span class="muted small">theo ĐĐ</span>'}</td>`).join('')}</tr>
      ${perms.items.map((p) => `<tr><td>${esc(p.module)} · ${esc(p.name)}</td>${roles.items.map((r) => `<td class="c">${r.permissions.includes(p.code) ? '<span class="yes">✓</span>' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else {
    box.innerHTML = `<div class="card flush tbl-wrap"><table><thead><tr><th>Mã</th><th>Chức danh</th><th>Bộ phận</th><th>Phạm vi</th><th class="right">Số quyền</th><th class="right">Người dùng</th></tr></thead><tbody>
      ${roles.items.map((r) => `<tr class="clickable" data-id="${r.id}"><td class="mono">${esc(r.code)}</td><td><b>${esc(r.name)}</b>${r.is_system ? ' <span class="badge">Hệ thống</span>' : ''}<div class="small muted">${esc(r.description || '')}</div></td><td>${esc(r.department || '')}</td><td>${r.all_locations ? '<span class="badge teal">Toàn hệ thống</span>' : 'Theo địa điểm được giao'}</td><td class="right">${r.permissions.length}/${perms.items.length}</td><td class="right"><a href="/users?role_id=${r.id}">${r.user_count}</a></td></tr>`).join('')}</tbody></table></div>`;
    $$('[data-id]', box).forEach((r) => r.addEventListener('click', (e) => { if (!e.target.closest('a')) edit(roles.items.find((x) => x.id == r.dataset.id)); }));
  }
  const groups = {};
  for (const p of perms.items) (groups[p.module] ||= []).push(p);
  const edit = (r = { permissions: [] }) => {
    const sys = !!r.is_system;
    const actions = sys ? [] : [{ label: 'Lưu', cls: 'primary', onClick: async ({ el: m, close }) => {
      const f = readForm($('.form', m)); f.permissions = $$('.pp:checked', m).map((c) => c.value);
      r.id ? await PUT('/api/roles/' + r.id, f) : await POST('/api/roles', f); close(); toast('Đã lưu chức danh'); pageRoles(el);
    } }];
    if (r.id && !sys) actions.unshift({ label: 'Xoá', cls: 'danger', onClick: async ({ close }) => { if (await confirmBox('Xoá chức danh ' + esc(r.name) + '?', 'Xoá', 'danger solid')) { await DEL('/api/roles/' + r.id); close(); pageRoles(el); } } });
    const m = modal({ title: r.id ? 'Chức danh: ' + r.name : 'Thêm chức danh', wide: true, actions, body: `${sys ? '<div class="alert">Chức danh hệ thống luôn có toàn quyền và không thể sửa.</div>' : ''}<div class="form">
      ${field({ name: 'code', label: 'Mã', value: r.code, required: true, disabled: sys })}${field({ name: 'name', label: 'Tên chức danh', value: r.name, required: true, disabled: sys })}${field({ name: 'department', label: 'Bộ phận', value: r.department, disabled: sys })}
      ${field({ name: 'description', label: 'Mô tả công việc', value: r.description, cls: 'two', disabled: sys })}${field({ name: 'all_locations', label: 'Phạm vi toàn hệ thống (mọi địa điểm)', type: 'checkbox', value: r.all_locations, disabled: sys })}</div>
      <h3>Thao tác nghiệp vụ được phép</h3>${Object.entries(groups).map(([g, list]) => `<div class="perm-group"><div><label><input type="checkbox" class="pg" ${sys ? 'disabled' : ''}> ${esc(g)}</label></div>${list.map((p) => `<label class="perm-item"><input type="checkbox" class="pp" value="${p.code}" ${r.permissions.includes(p.code) ? 'checked' : ''} ${sys ? 'disabled' : ''}><span>${esc(p.name)}</span><span class="code">${p.code}</span></label>`).join('')}</div>`).join('')}` });
    $$('.pg', m.el).forEach((g) => { const items = $$('.pp', g.closest('.perm-group')); g.checked = items.every((i) => i.checked); g.onchange = () => items.forEach((i) => (i.checked = g.checked)); });
  };
  $('#add').onclick = () => edit();
}

// ---------------- Nhật ký ----------------
async function pageAudit(el) {
  setTitle('Nhật ký hệ thống');
  const q = Object.fromEntries(new URLSearchParams(location.search));
  const d = await GET('/api/audit?' + qs(q));
  el.innerHTML = `<div class="card"><form class="filters" id="f" style="grid-template-columns:repeat(4,1fr)">${field({ name: 'action', label: 'Thao tác', value: q.action, type: 'select', options: [['', 'Tất cả'], ['login', 'Đăng nhập'], ['asset', 'Tài sản'], ['maintenance', 'Bảo trì'], ['incident', 'Sự cố'], ['transfer', 'Điều chuyển'], ['user', 'Người dùng'], ['role', 'Chức danh'], ['location', 'Địa điểm']] })}
    ${field({ name: 'user_id', label: 'Người dùng', type: 'select', value: q.user_id, options: userOptions('Tất cả') })}${field({ name: 'from', label: 'Từ ngày', type: 'date', value: q.from })}${field({ name: 'to', label: 'Đến ngày', type: 'date', value: q.to })}</form></div>
    <div class="card flush tbl-wrap"><table><thead><tr><th>Thời gian</th><th>Người dùng</th><th>Thao tác</th><th>Đối tượng</th><th>Chi tiết</th><th>IP</th></tr></thead><tbody>
    ${d.items.map((g) => `<tr><td class="nowrap">${dt(g.created_at)}</td><td>${esc(g.user_name || '')}</td><td class="mono small">${esc(g.action)}</td><td>${g.asset_code ? `<a href="/assets/${g.entity_id}" class="mono small">${esc(g.asset_code)}</a>` : esc((g.entity || '') + (g.entity_id ? ' #' + g.entity_id : ''))}</td><td class="small mono" style="max-width:520px;word-break:break-all">${esc(g.detail || '')}</td><td class="small">${esc(g.ip || '')}</td></tr>`).join('')}</tbody></table>
    <div class="pager">${d.page > 1 ? `<a class="btn sm" href="/audit?${qs({ ...q, page: d.page - 1 })}">‹ Mới hơn</a>` : ''}${d.items.length === 100 ? `<a class="btn sm" href="/audit?${qs({ ...q, page: d.page + 1 })}">Cũ hơn ›</a>` : ''}</div></div>`;
  $('#f', el).onchange = (e) => go('/audit?' + qs(readForm(e.currentTarget)));
}

// ---------------- Nhập file ----------------
async function pageImport(el) {
  setTitle('Nhập tài sản từ file CSV');
  el.innerHTML = `<div class="card"><h2>Bước 1 – Tải file mẫu</h2><p>File CSV (UTF-8) mở được bằng Excel/Google Sheets. Mỗi dòng là một tài sản. Cột <span class="mono">category_code</span> và <span class="mono">location_code</span> phải đúng mã trong hệ thống (VD: <span class="mono">DL</span>, <span class="mono">S08</span>). Cột <span class="mono">custodian</span> nhập email/SĐT/mã NV của người quản lý. Nếu <span class="mono">asset_code</span> đã tồn tại, dòng đó sẽ <b>cập nhật</b> tài sản.</p>
    <a class="btn" href="/api/assets/import-template.csv" download>⬇️ Tải file mẫu</a>
    <h3>Mã loại tài sản</h3><div class="small">${S.lookups.categories.map((c) => `<span class="badge" style="margin:2px">${esc(c.code)} · ${esc(c.name)}</span>`).join('')}</div></div>
    <div class="card"><h2>Bước 2 – Chọn file & kiểm tra</h2><input type="file" id="file" accept=".csv,text/csv"><div class="row" style="margin-top:12px"><button class="btn" id="check" disabled>🔍 Kiểm tra</button><button class="btn primary" id="run" disabled>📥 Nhập dữ liệu</button></div><div id="out" style="margin-top:12px"></div></div>`;
  let csv = '';
  $('#file', el).onchange = async (e) => { csv = await e.target.files[0]?.text() || ''; $('#check', el).disabled = $('#run', el).disabled = !csv; $('#out', el).innerHTML = ''; };
  const run = async (dry) => {
    const r = await POST('/api/assets/import', { csv, dry_run: dry });
    $('#out', el).innerHTML = `<div class="alert ${r.errors.length ? 'bad' : 'ok'}">${dry ? 'Kiểm tra' : 'Nhập'}: ${r.created} tài sản mới, ${r.updated} cập nhật, ${r.errors.length} lỗi. ${r.committed ? '<b>Đã lưu vào hệ thống.</b>' : r.errors.length ? 'Chưa lưu – hãy sửa lỗi rồi thử lại.' : 'Dữ liệu hợp lệ, bấm "Nhập dữ liệu" để lưu.'}</div>
      ${r.errors.length ? `<table><thead><tr><th>Dòng</th><th>Lỗi</th></tr></thead><tbody>${r.errors.map((x) => `<tr><td>${x.line}</td><td>${esc(x.error)}</td></tr>`).join('')}</tbody></table>` : ''}`;
  };
  $('#check', el).onclick = () => run(true).catch((e) => toast(e.message, true));
  $('#run', el).onclick = () => run(false).catch((e) => toast(e.message, true));
}

route();
