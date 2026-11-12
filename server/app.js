import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { db, withSql } from './db.js';
import { loadAccess, can } from './rbac.js';
import { sha256 } from './security.js';
import { createRouter, readBody, parseCookies, sendJson, HttpError, forbidden } from './http.js';
import registerAuth from './routes/auth.js';
import registerAssets from './routes/assets.js';
import registerOps from './routes/operations.js';
import registerAdmin from './routes/admin.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/**
 * @param {object} opts
 * @param {() => {sql: any, done?: () => void} | null} [opts.connect]  Tạo kết nối CSDL riêng cho từng request (Workers).
 *        Bỏ trống = dùng kết nối mặc định (Node.js).
 * @param {boolean} [opts.serveStatic=true]  Phục vụ thư mục public/ (Workers dùng Static Assets nên tắt).
 */
export function createApp({ connect, serveStatic = true } = {}) {
  const router = createRouter();

  const audit = (ctx, action, entity, entityId, detail) =>
    db.run('INSERT INTO audit_logs(user_id, action, entity, entity_id, detail, ip) VALUES (?,?,?,?,?,?)',
      ctx.access?.user.id ?? null, action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null, ctx.ip ?? null);

  // Đăng ký route với yêu cầu quyền: null = công khai, 'auth' = cần đăng nhập, 'x.y' hoặc ['x.y','z.w'] = cần 1 trong các quyền
  const api = {};
  for (const m of ['get', 'post', 'put', 'del']) {
    api[m] = (p, perm, fn) => router[m](p, async (ctx) => {
      if (perm !== null) {
        if (!ctx.access) throw new HttpError(401, 'Vui lòng đăng nhập');
        if (ctx.access.user.must_change_password && perm !== 'auth') throw new HttpError(403, 'Bạn cần đổi mật khẩu trước khi sử dụng', { mustChangePassword: true });
        if (perm !== 'auth' && ![].concat(perm).some((x) => can(ctx.access, x))) throw forbidden();
      }
      return fn(ctx);
    });
  }

  const shared = { db, api, audit, config };
  registerAuth(shared);
  registerAssets(shared);
  registerOps(shared);
  registerAdmin(shared);

  const publicDir = path.join(ROOT, 'public');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const ip = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/print/');
      if (isApi) {
        const match = router.match(req.method, url.pathname);
        if (!match) throw new HttpError(404, 'API không tồn tại');
        // Chống CSRF: mọi request thay đổi dữ liệu phải có header X-SBTT
        if (req.method !== 'GET' && req.headers['x-sbtt'] !== '1') throw forbidden('Thiếu header bảo mật');
        // Phiên đăng nhập
        const cookies = parseCookies(req);
        let access = null, session = null;
        if (cookies.sbtt_sid) {
          session = await db.get("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')", sha256(cookies.sbtt_sid));
          if (session) {
            access = await loadAccess(db, session.user_id);
            if (access?.user.status !== 'active') access = null;
          }
        }
        const body = req.method === 'GET' ? {} : await readBody(req);
        const ctx = { req, res, url, params: match.params, query: Object.fromEntries(url.searchParams), body, access, session, ip, cookies };
        let result;
        for (const h of match.handlers) result = await h(ctx);
        if (res.writableEnded || res.headersSent) return;
        return sendJson(res, 200, result ?? { ok: true });
      }
      if (!serveStatic) throw new HttpError(404, 'Không tìm thấy');
      // Tệp tĩnh + SPA (chỉ khi chạy Node.js)
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const file = path.normalize(path.join(publicDir, url.pathname));
      if (file.startsWith(publicDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(publicDir, 'index.html')));
    } catch (e) {
      if (!(e instanceof HttpError)) {
        // Mã lỗi PostgreSQL: 23505 trùng khoá duy nhất, 23503 vi phạm khoá ngoại, 23514 vi phạm CHECK
        if (e.code === '23505') e = new HttpError(409, 'Dữ liệu bị trùng: ' + (e.detail || e.constraint_name || e.message));
        else if (e.code === '23503') e = new HttpError(409, 'Dữ liệu đang được sử dụng hoặc tham chiếu không hợp lệ');
        else if (e.code === '23514' || e.code === '22P02' || e.code === '22003') e = new HttpError(400, 'Giá trị không hợp lệ');
        else { console.error(e); e = new HttpError(500, 'Lỗi hệ thống'); }
      }
      if (!res.headersSent) sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
    }
  }

  const server = http.createServer((req, res) => {
    const scope = connect?.();
    const p = scope ? withSql(scope.sql, () => handle(req, res)) : handle(req, res);
    return p.finally(() => scope?.done?.());
  });
  return { server };
}
